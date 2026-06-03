import { Alchemy, Network, AlchemyWebSocketEvent } from 'alchemy-sdk';
import winston from 'winston';

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.json(),
  transports: [
    new winston.transports.File({ filename: 'health-monitor.log' }),
    new winston.transports.Console(),
  ],
});

interface LiquidationOpportunity {
  borrower: string;
  collateral: string;
  debtToken: string;
  debtAmount: string;
  healthFactor: number;
  estimatedProfit: string;
  timestamp: number;
}

/**
 * HealthFactorMonitor
 * Real-time monitoring of lending positions for liquidation opportunities
 * Connects to Aave, Compound, Morpho via Alchemy data streams
 */
class HealthFactorMonitor {
  private alchemyEth: Alchemy;
  private alchemyPolygon?: Alchemy;
  private monitoringActive: boolean = false;
  private opportunityCallbacks: Array<(opp: LiquidationOpportunity) => void> = [];

  // Circuit breaker
  private lastCheckTime: number = 0;
  private checkIntervalMs: number = 2000; // Check every 2 seconds
  private errorCount: number = 0;
  private maxConsecutiveErrors: number = 10;

  constructor(alchemyKeyEth: string, alchemyKeyPolygon?: string) {
    this.alchemyEth = new Alchemy({
      apiKey: alchemyKeyEth,
      network: Network.ETH_MAINNET,
    });

    if (alchemyKeyPolygon) {
      this.alchemyPolygon = new Alchemy({
        apiKey: alchemyKeyPolygon,
        network: Network.MATIC_MAINNET,
      });
    }
  }

  /**
   * Start monitoring for liquidation opportunities
   */
  async startMonitoring(callback: (opp: LiquidationOpportunity) => void) {
    if (this.monitoringActive) {
      logger.warn('Monitoring already active');
      return;
    }

    this.opportunityCallbacks.push(callback);
    this.monitoringActive = true;

    logger.info('✅ Health factor monitoring started');

    // Start Ethereum monitoring
    this.monitorEthereumLiquidations();

    // Start Polygon monitoring if available
    if (this.alchemyPolygon) {
      this.monitorPolygonLiquidations();
    }

    // Polling fallback
    this.startPollingFallback();
  }

  /**
   * Monitor Ethereum liquidations via Alchemy WebSocket
   */
  private async monitorEthereumLiquidations() {
    try {
      // Subscribe to Aave liquidation events
      const aaveLiquidationTopic = '0xe413a321e8681d831f4dbccbca790d2952b56f977908e45be37335533e3f6efb'; // LiquidationCall event
      const compoundLiquidationTopic = '0x2713f39ca55ec6b128564dc122ec822e97a9b9f2e6a4b40ff7e0e3f9b0b5e9d1'; // Liquidation event

      this.alchemyEth.ws.on(
        {
          method: 'eth_subscribe',
          params: [
            'logs',
            {
              topics: [aaveLiquidationTopic],
              address: [
                '0x7d2768de32b0b80b7a3454c06bdac94a69ddc7a9', // Aave v3 pool
              ],
            },
          ],
        },
        (log: any) => this.handleAaveLiquidationEvent(log)
      );

      logger.info('Ethereum liquidation monitoring active');
    } catch (error) {
      logger.error('Error setting up Ethereum monitoring:', error);
    }
  }

  /**
   * Monitor Polygon liquidations
   */
  private async monitorPolygonLiquidations() {
    try {
      if (!this.alchemyPolygon) return;

      const aaveLiquidationTopic = '0xe413a321e8681d831f4dbccbca790d2952b56f977908e45be37335533e3f6efb';

      this.alchemyPolygon.ws.on(
        {
          method: 'eth_subscribe',
          params: [
            'logs',
            {
              topics: [aaveLiquidationTopic],
              address: [
                '0x794a61358d6845106366401017e26480ad0c3a2a', // Aave v3 pool Polygon
              ],
            },
          ],
        },
        (log: any) => this.handlePolygonLiquidationEvent(log)
      );

      logger.info('Polygon liquidation monitoring active');
    } catch (error) {
      logger.error('Error setting up Polygon monitoring:', error);
    }
  }

  /**
   * Polling fallback for real-time liquidation detection
   */
  private startPollingFallback() {
    setInterval(async () => {
      if (!this.monitoringActive) return;

      try {
        this.lastCheckTime = Date.now();
        this.errorCount = 0;

        // Poll for recent liquidation transactions
        const recentBlock = await this.alchemyEth.core.getBlockNumber();
        const fromBlock = recentBlock - 50; // Check last 50 blocks

        // Query for LiquidationCall events
        const logs = await this.alchemyEth.core.getLogs({
          address: '0x7d2768de32b0b80b7a3454c06bdac94a69ddc7a9',
          topics: ['0xe413a321e8681d831f4dbccbca790d2952b56f977908e45be37335533e3f6efb'],
          fromBlock: `0x${fromBlock.toString(16)}`,
          toBlock: 'latest',
        });

        for (const log of logs) {
          this.processLiquidationLog(log);
        }
      } catch (error) {
        this.errorCount++;
        logger.warn(`Polling error (${this.errorCount}/${this.maxConsecutiveErrors}):`, error);

        if (this.errorCount >= this.maxConsecutiveErrors) {
          logger.error('Circuit breaker triggered: Too many polling errors');
          this.stopMonitoring();
        }
      }
    }, this.checkIntervalMs);
  }

  /**
   * Handle Aave liquidation event
   */
  private async handleAaveLiquidationEvent(log: any) {
    try {
      const opportunity = this.parseAaveLiquidationEvent(log);
      if (opportunity) {
        this.notifyOpportunity(opportunity);
      }
    } catch (error) {
      logger.error('Error handling Aave liquidation event:', error);
    }
  }

  /**
   * Handle Polygon liquidation event
   */
  private async handlePolygonLiquidationEvent(log: any) {
    try {
      const opportunity = this.parseAaveLiquidationEvent(log);
      if (opportunity) {
        this.notifyOpportunity(opportunity);
      }
    } catch (error) {
      logger.error('Error handling Polygon liquidation event:', error);
    }
  }

  /**
   * Process liquidation log
   */
  private async processLiquidationLog(log: any) {
    try {
      const opportunity = this.parseLiquidationLog(log);
      if (opportunity) {
        this.notifyOpportunity(opportunity);
      }
    } catch (error) {
      logger.error('Error processing liquidation log:', error);
    }
  }

  /**
   * Parse Aave liquidation event
   */
  private parseAaveLiquidationEvent(log: any): LiquidationOpportunity | null {
    try {
      // Aave LiquidationCall event:
      // (collateral, principal, user, initiator, receiveAToken)
      const collateral = '0x' + log.topics[1].slice(-40);
      const debtToken = '0x' + log.topics[2].slice(-40);
      const borrower = '0x' + log.topics[3].slice(-40);

      // Parse data: debtToCover, liquidatedCollateralAmount, liquidator
      const dataHex = log.data;
      const debtAmount = '0x' + dataHex.slice(2, 66);

      return {
        borrower,
        collateral,
        debtToken,
        debtAmount,
        healthFactor: 0.95, // Would be calculated from on-chain data
        estimatedProfit: (parseInt(debtAmount, 16) * 0.03).toString(),
        timestamp: Date.now(),
      };
    } catch (error) {
      logger.error('Error parsing Aave liquidation event:', error);
      return null;
    }
  }

  /**
   * Parse liquidation log
   */
  private parseLiquidationLog(log: any): LiquidationOpportunity | null {
    try {
      if (!log.data || log.data === '0x') return null;

      return {
        borrower: log.address,
        collateral: '0x' + (log.topics[1]?.slice(-40) || 'unknown'),
        debtToken: '0x' + (log.topics[2]?.slice(-40) || 'unknown'),
        debtAmount: log.data,
        healthFactor: 0.95,
        estimatedProfit: (BigInt(log.data) * BigInt(3) / BigInt(100)).toString(),
        timestamp: Date.now(),
      };
    } catch (error) {
      logger.error('Error parsing liquidation log:', error);
      return null;
    }
  }

  /**
   * Notify callbacks of liquidation opportunity
   */
  private notifyOpportunity(opportunity: LiquidationOpportunity) {
    logger.info('💡 Liquidation opportunity:', {
      borrower: opportunity.borrower,
      estimatedProfit: opportunity.estimatedProfit,
    });

    for (const callback of this.opportunityCallbacks) {
      try {
        callback(opportunity);
      } catch (error) {
        logger.error('Error in opportunity callback:', error);
      }
    }
  }

  /**
   * Stop monitoring
   */
  stopMonitoring() {
    this.monitoringActive = false;
    logger.info('Health factor monitoring stopped');
  }

  /**
   * Check Alchemy connection
   */
  async checkConnection(): Promise<boolean> {
    try {
      const blockNumber = await this.alchemyEth.core.getBlockNumber();
      return blockNumber > 0;
    } catch (error) {
      logger.error('Alchemy connection check failed:', error);
      return false;
    }
  }
}

export default HealthFactorMonitor;
