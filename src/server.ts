import express from 'express';
import { ethers } from 'ethers';
import winston from 'winston';
import HealthFactorMonitor from './services/HealthFactorMonitor';
import LiquidationExecutor from './services/LiquidationExecutor';
import TreasuryManager from './services/TreasuryManager';
import AutoDeployer from './services/AutoDeployer';
import ModemPayIntegration from './services/ModemPayIntegration';

// Initialize logger
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.json(),
  transports: [
    new winston.transports.File({ filename: 'error.log', level: 'error' }),
    new winston.transports.File({ filename: 'combined.log' }),
    new winston.transports.Console({
      format: winston.format.simple(),
    }),
  ],
});

const app = express();
app.use(express.json());

// Initialize services
const monitor = new HealthFactorMonitor(
  process.env.ALCHEMY_KEY!,
  process.env.ALCHEMY_POLYGON_KEY
);

const executor = new LiquidationExecutor(
  process.env.RPC_URL!,
  process.env.PRIVATE_KEY!,
  process.env.ENGINE_ADDRESS!
);

const treasury = new TreasuryManager(
  process.env.RPC_URL!,
  process.env.TREASURY_ADDRESS!,
  process.env.MODEM_PAY_SECRET!
);

const deployer = new AutoDeployer(
  process.env.RPC_URL!,
  process.env.PRIVATE_KEY!,
  process.env.DEPLOYER_ADDRESS!
);

const modemPay = new ModemPayIntegration(
  process.env.MODEM_PAY_API_KEY!,
  process.env.MODEM_PAY_SECRET!
);

// State management
interface SystemMetrics {
  startTime: number;
  totalLiquidations: number;
  totalFeesCollected: bigint;
  totalWithdrawn: bigint;
  totalReinvested: bigint;
  deploymentProgress: {
    day: number;
    nextDeployment: string;
    completedDeployments: string[];
    failedDeployments: string[];
  };
  systemHealth: {
    alchemy: boolean;
    pimlico: boolean;
    treasury: boolean;
    deployer: boolean;
    modemPay: boolean;
  };
}

const metrics: SystemMetrics = {
  startTime: Date.now(),
  totalLiquidations: 0,
  totalFeesCollected: BigInt(0),
  totalWithdrawn: BigInt(0),
  totalReinvested: BigInt(0),
  deploymentProgress: {
    day: 1,
    nextDeployment: 'Day 2: Compound',
    completedDeployments: [],
    failedDeployments: [],
  },
  systemHealth: {
    alchemy: false,
    pimlico: false,
    treasury: false,
    deployer: false,
    modemPay: false,
  },
};

// Routes

/**
 * Health check endpoint
 */
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    uptime: Date.now() - metrics.startTime,
    timestamp: new Date().toISOString(),
  });
});

/**
 * Get current revenue metrics
 */
app.get('/revenue', async (req, res) => {
  try {
    const stats = await treasury.getStats();
    const personalEarnings = Number(stats.personalEarnings);
    const projected = personalEarnings * 30; // Simple projection

    res.json({
      totalRevenue: Number(metrics.totalFeesCollected),
      personalEarnings,
      projectedMonthly: projected,
      totalLiquidations: metrics.totalLiquidations,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    logger.error('Revenue fetch error:', error);
    res.status(500).json({ error: 'Failed to fetch revenue' });
  }
});

/**
 * Get treasury balance
 */
app.get('/balance', async (req, res) => {
  try {
    const balance = await treasury.getBalance();
    const personal = await treasury.getPersonalEarnings();
    const reinvestment = await treasury.getReinvestmentPool();

    res.json({
      totalBalance: balance,
      personal,
      reinvestment,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    logger.error('Balance fetch error:', error);
    res.status(500).json({ error: 'Failed to fetch balance' });
  }
});

/**
 * Request withdrawal to bank
 */
app.post('/withdraw', async (req, res) => {
  try {
    const { amount } = req.body;

    if (!amount || typeof amount !== 'number' || amount <= 0) {
      return res.status(400).json({ error: 'Invalid amount' });
    }

    logger.info(`Withdrawal requested: ${amount}`);

    // Check available balance
    const personal = await treasury.getPersonalEarnings();
    if (personal < amount) {
      return res.status(400).json({
        error: 'Insufficient personal earnings',
        available: personal,
      });
    }

    // Initiate withdrawal
    const result = await treasury.requestWithdrawal(amount);

    // Confirm with Modem Pay
    const modemPayResult = await modemPay.initiateWithdrawal(amount, 'USD', {
      idempotencyKey: `x7-${Date.now()}`,
    });

    res.json({
      status: 'initiated',
      amount,
      reference: modemPayResult.reference,
      estimatedCompletion: '1-2 business days',
      timestamp: new Date().toISOString(),
    });

    logger.info(`Withdrawal initiated: ${amount}, Reference: ${modemPayResult.reference}`);
  } catch (error) {
    logger.error('Withdrawal error:', error);
    res.status(500).json({ error: 'Withdrawal failed' });
  }
});

/**
 * Get deployment status
 */
app.get('/deployment/status', async (req, res) => {
  try {
    const status = await deployer.getDeploymentStatus();

    res.json({
      currentDay: metrics.deploymentProgress.day,
      nextDeployment: metrics.deploymentProgress.nextDeployment,
      completed: metrics.deploymentProgress.completedDeployments,
      failed: metrics.deploymentProgress.failedDeployments,
      deploymentPercentage: (metrics.deploymentProgress.completedDeployments.length / 5) * 100,
      ...status,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    logger.error('Deployment status error:', error);
    res.status(500).json({ error: 'Failed to fetch deployment status' });
  }
});

/**
 * Get system health
 */
app.get('/health/system', async (req, res) => {
  try {
    const health = {
      overall: 'ok' as const,
      services: {
        alchemy: 'checking...',
        pimlico: 'checking...',
        treasury: 'checking...',
        deployer: 'checking...',
        modemPay: 'checking...',
      },
      uptime: Date.now() - metrics.startTime,
      timestamp: new Date().toISOString(),
    };

    // Check Alchemy
    try {
      await monitor.checkConnection();
      health.services.alchemy = 'ok';
      metrics.systemHealth.alchemy = true;
    } catch {
      health.services.alchemy = 'error';
      metrics.systemHealth.alchemy = false;
    }

    // Check Pimlico
    try {
      await executor.checkPimlico();
      health.services.pimlico = 'ok';
      metrics.systemHealth.pimlico = true;
    } catch {
      health.services.pimlico = 'error';
      metrics.systemHealth.pimlico = false;
    }

    // Check Treasury
    try {
      await treasury.checkHealth();
      health.services.treasury = 'ok';
      metrics.systemHealth.treasury = true;
    } catch {
      health.services.treasury = 'error';
      metrics.systemHealth.treasury = false;
    }

    // Check Deployer
    try {
      await deployer.checkHealth();
      health.services.deployer = 'ok';
      metrics.systemHealth.deployer = true;
    } catch {
      health.services.deployer = 'error';
      metrics.systemHealth.deployer = false;
    }

    // Check Modem Pay
    try {
      await modemPay.checkHealth();
      health.services.modemPay = 'ok';
      metrics.systemHealth.modemPay = true;
    } catch {
      health.services.modemPay = 'error';
      metrics.systemHealth.modemPay = false;
    }

    // Check overall health
    const healthCount = Object.values(metrics.systemHealth).filter((v) => v).length;
    if (healthCount < 4) {
      health.overall = 'warning';
    }
    if (healthCount < 3) {
      health.overall = 'error';
    }

    res.json(health);
  } catch (error) {
    logger.error('System health check error:', error);
    res.status(500).json({ error: 'Failed to check system health' });
  }
});

/**
 * Get analytics
 */
app.get('/analytics', async (req, res) => {
  try {
    const stats = await treasury.getStats();
    const daysSinceLaunch = Math.floor((Date.now() - metrics.startTime) / (24 * 60 * 60 * 1000));

    res.json({
      totalLiquidations: metrics.totalLiquidations,
      totalFees: Number(metrics.totalFeesCollected),
      personalEarnings: Number(stats.personalEarnings),
      reinvested: Number(stats.reinvested),
      daysSinceLaunch,
      averageLiquidationProfit: metrics.totalLiquidations > 0 
        ? Number(metrics.totalFeesCollected) / metrics.totalLiquidations 
        : 0,
      projectedMonthly: (Number(stats.personalEarnings) / (daysSinceLaunch || 1)) * 30,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    logger.error('Analytics error:', error);
    res.status(500).json({ error: 'Failed to fetch analytics' });
  }
});

/**
 * Get liquidation history
 */
app.get('/liquidations', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit as string) || 50;
    const history = await executor.getLiquidationHistory(limit);

    res.json({
      total: history.length,
      liquidations: history,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    logger.error('Liquidation history error:', error);
    res.status(500).json({ error: 'Failed to fetch liquidation history' });
  }
});

// Error handling middleware
app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
  logger.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// Start background services
async function startBackgroundServices() {
  logger.info('Starting background services...');

  // Start health factor monitoring
  monitor.startMonitoring((opportunity) => {
    logger.info('Liquidation opportunity detected:', opportunity);
    metrics.deploymentProgress.day = Math.floor((Date.now() - metrics.startTime) / (24 * 60 * 60 * 1000)) + 1;
  });

  // Start auto-deployment checker
  deployer.startAutoDeploymentLoop((result) => {
    logger.info('Deployment update:', result);
    if (result.success) {
      metrics.deploymentProgress.completedDeployments.push(result.deployment);
    } else {
      metrics.deploymentProgress.failedDeployments.push(result.deployment);
    }
  });

  logger.info('Background services started');
}

// Start server
const PORT = process.env.PORT || 3000;

async function main() {
  try {
    await startBackgroundServices();

    app.listen(PORT, () => {
      logger.info(`🚀 X7 Liquidation MVP running on port ${PORT}`);
      logger.info(`📊 Start time: ${new Date(metrics.startTime).toISOString()}`);
      logger.info(`⛓️  Monitoring liquidations on Ethereum mainnet`);
      logger.info(`🤖 Auto-deployment engine active (Days 1-7 schedule)`);
      logger.info(`💳 Modem Pay integration ready for withdrawals`);
    });
  } catch (error) {
    logger.error('Failed to start server:', error);
    process.exit(1);
  }
}

main();
