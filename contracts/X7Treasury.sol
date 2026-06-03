// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";

interface IModemPay {
    function initiateWithdrawal(address token, uint256 amount, address recipient) external returns (bool);
}

/**
 * @title X7Treasury
 * @notice Aggregates all liquidation fees and manages revenue splits
 * @dev 70% reinvestment, 30% personal withdrawals
 */
contract X7Treasury is Ownable, ReentrancyGuard {
    
    mapping(address => uint256) public balances;
    mapping(address => uint256) public personalEarnings;
    mapping(address => uint256) public reinvestmentPool;
    
    address public modemPayAgent;
    address public liquidationEngine;
    
    uint256 public constant PERSONAL_SPLIT = 30; // 30%
    uint256 public constant REINVESTMENT_SPLIT = 70; // 70%
    uint256 public constant BASIS_POINTS = 100;
    
    uint256 public totalFeesReceived;
    uint256 public totalWithdrawn;
    uint256 public totalReinvested;
    
    bool public paused;
    
    event FeeReceived(address indexed token, uint256 amount, address indexed from);
    event WithdrawalInitiated(address indexed token, uint256 amount, address indexed recipient);
    event WithdrawalCompleted(address indexed token, uint256 amount);
    event RevenueAllocated(address indexed token, uint256 personal, uint256 reinvestment);
    event ReinvestmentDeployed(address indexed token, uint256 amount, string destination);
    event PausedStatusChanged(bool paused);
    event EmergencyWithdrawal(address indexed token, uint256 amount);

    constructor(address _modemPayAgent, address _liquidationEngine) {
        require(_modemPayAgent != address(0), "Invalid Modem Pay agent");
        require(_liquidationEngine != address(0), "Invalid liquidation engine");
        
        modemPayAgent = _modemPayAgent;
        liquidationEngine = _liquidationEngine;
    }

    /**
     * @notice Receive fees from liquidation engine
     */
    function receiveFee(address token, uint256 amount) 
        external 
        onlyLiquidationEngine 
        nonReentrant 
    {
        require(token != address(0), "Invalid token");
        require(amount > 0, "Invalid amount");
        require(!paused, "Treasury paused");

        // Transfer token to treasury
        require(
            IERC20(token).transferFrom(msg.sender, address(this), amount),
            "Transfer failed"
        );

        // Update balances
        balances[token] += amount;
        totalFeesReceived += amount;

        // Allocate to personal and reinvestment
        uint256 personalAmount = (amount * PERSONAL_SPLIT) / BASIS_POINTS;
        uint256 reinvestAmount = (amount * REINVESTMENT_SPLIT) / BASIS_POINTS;

        personalEarnings[token] += personalAmount;
        reinvestmentPool[token] += reinvestAmount;

        emit FeeReceived(token, amount, msg.sender);
        emit RevenueAllocated(token, personalAmount, reinvestAmount);
    }

    /**
     * @notice Request withdrawal to bank via Modem Pay
     */
    function requestWithdrawal(address token, uint256 amount) 
        external 
        onlyOwner 
        nonReentrant 
        returns (bool) 
    {
        require(token != address(0), "Invalid token");
        require(amount > 0, "Invalid amount");
        require(personalEarnings[token] >= amount, "Insufficient personal earnings");
        require(!paused, "Treasury paused");

        // Deduct from personal earnings
        personalEarnings[token] -= amount;
        totalWithdrawn += amount;

        // Approve and initiate withdrawal via Modem Pay
        IERC20(token).approve(modemPayAgent, amount);
        
        require(
            IModemPay(modemPayAgent).initiateWithdrawal(token, amount, owner()),
            "Modem Pay withdrawal failed"
        );

        emit WithdrawalInitiated(token, amount, owner());
        return true;
    }

    /**
     * @notice Complete withdrawal (called by Modem Pay after settlement)
     */
    function completeWithdrawal(address token, uint256 amount) 
        external 
        onlyModemPay 
    {
        require(token != address(0), "Invalid token");
        require(amount > 0, "Invalid amount");

        balances[token] -= amount;
        emit WithdrawalCompleted(token, amount);
    }

    /**
     * @notice Get personal earnings available for withdrawal
     */
    function getPersonalEarnings(address token) 
        external 
        view 
        returns (uint256) 
    {
        return personalEarnings[token];
    }

    /**
     * @notice Get reinvestment pool balance
     */
    function getReinvestmentPool(address token) 
        external 
        view 
        returns (uint256) 
    {
        return reinvestmentPool[token];
    }

    /**
     * @notice Get total treasury balance
     */
    function getTotalBalance(address token) 
        external 
        view 
        returns (uint256) 
    {
        return balances[token];
    }

    /**
     * @notice Get treasury statistics
     */
    function getStats() 
        external 
        view 
        returns (
            uint256 total,
            uint256 withdrawn,
            uint256 reinvested
        ) 
    {
        return (totalFeesReceived, totalWithdrawn, totalReinvested);
    }

    /**
     * @notice Allocate reinvestment pool (called by auto-deployer)
     */
    function deployReinvestment(
        address token,
        uint256 amount,
        string memory destination
    ) 
        external 
        onlyOwner 
        nonReentrant 
    {
        require(token != address(0), "Invalid token");
        require(amount > 0, "Invalid amount");
        require(reinvestmentPool[token] >= amount, "Insufficient reinvestment pool");
        require(!paused, "Treasury paused");

        reinvestmentPool[token] -= amount;
        totalReinvested += amount;

        // Transfer to deployment address
        require(
            IERC20(token).transfer(msg.sender, amount),
            "Transfer failed"
        );

        emit ReinvestmentDeployed(token, amount, destination);
    }

    /**
     * @notice Pause treasury (emergency)
     */
    function pause() external onlyOwner {
        paused = true;
        emit PausedStatusChanged(true);
    }

    /**
     * @notice Resume treasury
     */
    function resume() external onlyOwner {
        paused = false;
        emit PausedStatusChanged(false);
    }

    /**
     * @notice Emergency withdrawal (only owner, for security)
     */
    function emergencyWithdraw(address token, uint256 amount) 
        external 
        onlyOwner 
        nonReentrant 
    {
        require(token != address(0), "Invalid token");
        require(amount > 0, "Invalid amount");
        require(balances[token] >= amount, "Insufficient balance");

        balances[token] -= amount;
        require(
            IERC20(token).transfer(owner(), amount),
            "Transfer failed"
        );

        emit EmergencyWithdrawal(token, amount);
    }

    /**
     * @notice Update Modem Pay agent
     */
    function updateModemPayAgent(address newAgent) external onlyOwner {
        require(newAgent != address(0), "Invalid agent");
        modemPayAgent = newAgent;
    }

    /**
     * @notice Update liquidation engine
     */
    function updateLiquidationEngine(address newEngine) external onlyOwner {
        require(newEngine != address(0), "Invalid engine");
        liquidationEngine = newEngine;
    }

    modifier onlyLiquidationEngine() {
        require(msg.sender == liquidationEngine, "Only liquidation engine");
        _;
    }

    modifier onlyModemPay() {
        require(msg.sender == modemPayAgent, "Only Modem Pay agent");
        _;
    }
}
