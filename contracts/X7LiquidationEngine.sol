// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "@aave/core-v3/contracts/interfaces/IPool.sol";
import "@aave/core-v3/contracts/interfaces/IFlashLoanReceiver.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

interface IAddressesProvider {
    function getPool() external view returns (address);
}

/**
 * @title X7LiquidationEngine
 * @notice Core liquidation contract for Aave positions
 * @dev Handles flash loan liquidations with fee capture
 */
contract X7LiquidationEngine is IFlashLoanReceiver, Ownable {
    
    IPool public aavePool;
    address public treasury;
    uint256 public constant FEE_PERCENT = 3; // 3% fee
    uint256 public constant BASIS_POINTS = 10000;
    
    mapping(address => bool) public whitelistedExecutors;
    
    uint256 public totalLiquidations;
    uint256 public totalFeesCollected;
    
    struct LiquidationRecord {
        address borrower;
        address collateral;
        address debtToken;
        uint256 debtAmount;
        uint256 profitAmount;
        uint256 feeAmount;
        uint256 timestamp;
    }
    
    LiquidationRecord[] public liquidationHistory;
    
    event LiquidationExecuted(
        address indexed borrower,
        address indexed collateral,
        address indexed debtToken,
        uint256 debtAmount,
        uint256 profit,
        uint256 fee,
        uint256 timestamp
    );
    
    event ExecutorWhitelisted(address indexed executor);
    event ExecutorRemovedFromWhitelist(address indexed executor);
    event TreasuryUpdated(address indexed newTreasury);
    event CircuitBreakerTriggered(string reason);

    constructor(address _aavePool, address _treasury) {
        require(_aavePool != address(0), "Invalid Aave pool");
        require(_treasury != address(0), "Invalid treasury");
        
        aavePool = IPool(_aavePool);
        treasury = _treasury;
        whitelistedExecutors[msg.sender] = true;
    }

    /**
     * @notice Execute liquidation via flash loan
     * @param borrower Address of borrower to liquidate
     * @param collateralToken Collateral token address
     * @param debtToken Debt token address
     * @param debtAmount Amount of debt to repay
     * @return feeAmount Amount of fee collected
     */
    function executeLiquidation(
        address borrower,
        address collateralToken,
        address debtToken,
        uint256 debtAmount
    ) external onlyWhitelisted returns (uint256 feeAmount) {
        require(borrower != address(0), "Invalid borrower");
        require(collateralToken != address(0), "Invalid collateral");
        require(debtToken != address(0), "Invalid debt token");
        require(debtAmount > 0, "Invalid debt amount");

        // Initiate flash loan
        address[] memory assets = new address[](1);
        assets[0] = debtToken;
        
        uint256[] memory amounts = new uint256[](1);
        amounts[0] = debtAmount;
        
        uint256[] memory modes = new uint256[](1);
        modes[0] = 0; // No debt mode for flash loan
        
        bytes memory params = abi.encode(borrower, collateralToken, debtAmount);
        
        aavePool.flashLoan(
            address(this),
            assets,
            amounts,
            modes,
            address(this),
            params,
            0
        );

        // Calculate and transfer fee
        uint256 collateralBalance = IERC20(collateralToken).balanceOf(address(this));
        feeAmount = (collateralBalance * FEE_PERCENT) / BASIS_POINTS;
        
        // Safety check
        if (feeAmount == 0) {
            revert("No profit generated");
        }

        // Transfer fee to treasury
        IERC20(collateralToken).transfer(treasury, feeAmount);
        
        // Transfer remaining to executor
        uint256 remaining = collateralBalance - feeAmount;
        if (remaining > 0) {
            IERC20(collateralToken).transfer(msg.sender, remaining);
        }

        // Update metrics
        totalLiquidations++;
        totalFeesCollected += feeAmount;
        
        // Record liquidation
        liquidationHistory.push(LiquidationRecord({
            borrower: borrower,
            collateral: collateralToken,
            debtToken: debtToken,
            debtAmount: debtAmount,
            profitAmount: collateralBalance,
            feeAmount: feeAmount,
            timestamp: block.timestamp
        }));

        emit LiquidationExecuted(
            borrower,
            collateralToken,
            debtToken,
            debtAmount,
            collateralBalance,
            feeAmount,
            block.timestamp
        );

        return feeAmount;
    }

    /**
     * @notice Execute operation callback from Aave flash loan
     */
    function executeOperation(
        address asset,
        uint256 amount,
        uint256 premium,
        address initiator,
        bytes calldata params
    ) external override returns (bytes32) {
        require(msg.sender == address(aavePool), "Unauthorized");
        
        (address borrower, address collateral, uint256 debtAmount) = 
            abi.decode(params, (address, address, uint256));

        // Execute liquidation on Aave
        aavePool.liquidationCall(
            collateral,
            asset,
            borrower,
            debtAmount,
            false
        );

        // Repay flash loan + premium
        uint256 repayAmount = amount + premium;
        IERC20(asset).approve(address(aavePool), repayAmount);

        return keccak256("ERC3156FlashBorrower.onFlashLoan");
    }

    /**
     * @notice Get Aave addresses provider
     */
    function ADDRESSES_PROVIDER() external view override returns (IAddressesProvider) {
        return IAddressesProvider(aavePool.ADDRESSES_PROVIDER());
    }

    /**
     * @notice Whitelist executor for liquidations
     */
    function whitelistExecutor(address executor) external onlyOwner {
        require(executor != address(0), "Invalid executor");
        whitelistedExecutors[executor] = true;
        emit ExecutorWhitelisted(executor);
    }

    /**
     * @notice Remove executor from whitelist
     */
    function removeExecutor(address executor) external onlyOwner {
        whitelistedExecutors[executor] = false;
        emit ExecutorRemovedFromWhitelist(executor);
    }

    /**
     * @notice Update treasury address
     */
    function updateTreasury(address newTreasury) external onlyOwner {
        require(newTreasury != address(0), "Invalid treasury");
        treasury = newTreasury;
        emit TreasuryUpdated(newTreasury);
    }

    /**
     * @notice Get liquidation history length
     */
    function getHistoryLength() external view returns (uint256) {
        return liquidationHistory.length;
    }

    /**
     * @notice Get liquidation record
     */
    function getLiquidationRecord(uint256 index) 
        external 
        view 
        returns (LiquidationRecord memory) 
    {
        require(index < liquidationHistory.length, "Invalid index");
        return liquidationHistory[index];
    }

    /**
     * @notice Get recent liquidations
     */
    function getRecentLiquidations(uint256 count) 
        external 
        view 
        returns (LiquidationRecord[] memory) 
    {
        uint256 start = liquidationHistory.length > count 
            ? liquidationHistory.length - count 
            : 0;
        
        LiquidationRecord[] memory recent = new LiquidationRecord[](
            liquidationHistory.length - start
        );
        
        for (uint256 i = 0; i < recent.length; i++) {
            recent[i] = liquidationHistory[start + i];
        }
        
        return recent;
    }

    /**
     * @notice Check if executor is whitelisted
     */
    modifier onlyWhitelisted() {
        require(whitelistedExecutors[msg.sender], "Executor not whitelisted");
        _;
    }
}
