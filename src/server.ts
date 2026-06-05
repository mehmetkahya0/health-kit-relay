import express, { Request, Response, NextFunction } from 'express';
import helmet from 'helmet';
import cors from 'cors';
import dotenv from 'dotenv';

// Load environment variables from .env file
dotenv.config();

// Ensure the necessary configuration is present
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.HEALTHKIT_API_KEY;

if (!API_KEY) {
  console.error('================================================================');
  console.error('🔥 FATAL ERROR: HEALTHKIT_API_KEY is not defined in the environment!');
  console.error('Please configure it in your .env file before starting the server.');
  console.error('================================================================');
  process.exit(1);
}

const app = express();

// ==========================================
// Middleware Configuration
// ==========================================

// Helmet helps secure Express apps by setting various HTTP headers
// In development/local dashboard serving, we configure Content Security Policy (CSP) options
// to allow inline styles/fonts from Google Fonts and prevent stream resource blocking.
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        ...helmet.contentSecurityPolicy.getDefaultDirectives(),
        "style-src": ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
        "font-src": ["'self'", "https://fonts.gstatic.com"],
        "connect-src": ["'self'", "http://localhost:3000", "http://127.0.0.1:3000"]
      },
    },
  })
);

// Enable CORS for cross-origin client requests
app.use(cors());

// Parse incoming JSON payloads (up to 10MB to accommodate large workout files if needed)
app.use(express.json({ limit: '10mb' }));

// Serve static dashboard files from the "public" directory
app.use(express.static('public'));

// Logger middleware to print basic request information
app.use((req: Request, _res: Response, next: NextFunction) => {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] ${req.method} ${req.path} - IP: ${req.ip}`);
  next();
});

// ==========================================
// Real-time State & SSE Clients
// ==========================================
interface SSEClient {
  id: number;
  res: Response;
}

let sseClients: SSEClient[] = [];
let latestPayload: AppleHealthPayload | null = null;

// ==========================================
// Authentication Middleware
// ==========================================
interface AuthenticatedRequest extends Request {
  user?: { tokenUsed: string };
}

const authenticateApiKey = (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): void => {
  const authHeader = req.headers.authorization;

  if (!authHeader) {
    console.warn(`[WARN] Unauthorized access attempt from IP: ${req.ip} - Missing Authorization Header`);
    res.status(401).json({
      error: 'Unauthorized',
      message: 'Missing Authorization header. Use Bearer token authentication.',
    });
    return;
  }

  // Expect header format: Bearer <token>
  const parts = authHeader.split(' ');
  if (parts.length !== 2 || parts[0].toLowerCase() !== 'bearer') {
    console.warn(`[WARN] Invalid authorization format from IP: ${req.ip}`);
    res.status(401).json({
      error: 'Unauthorized',
      message: 'Invalid authorization format. Expected: Bearer <token>',
    });
    return;
  }

  const token = parts[1];
  if (token !== API_KEY) {
    console.warn(`[WARN] Failed authentication attempt with invalid token from IP: ${req.ip}`);
    res.status(401).json({
      error: 'Unauthorized',
      message: 'Invalid API Key.',
    });
    return;
  }

  // Token is valid
  req.user = { tokenUsed: token.substring(0, 8) + '...' };
  next();
};

// ==========================================
// TypeScript Interfaces for Health Data Payload
// ==========================================

interface MetricDetail {
  value: number;
  unit: string;
}

interface WorkoutDetail {
  type: string;
  startDate: string;
  endDate: string;
  durationSeconds: number;
  activeEnergyBurned?: MetricDetail;
  distance?: MetricDetail;
}

interface AppleHealthPayload {
  timestamp: string;
  device?: string;
  metrics: {
    steps?: MetricDetail;
    activeEnergy?: MetricDetail;
    [key: string]: MetricDetail | undefined;
  };
  workouts?: WorkoutDetail[];
}

// ==========================================
// API Routes
// ==========================================

/**
 * Health check route for load balancers or uptime monitors
 */
app.get('/health', (_req: Request, res: Response) => {
  res.status(200).json({
    status: 'UP',
    timestamp: new Date().toISOString(),
    version: '1.0.0',
  });
});

/**
 * Get the latest received Apple Health payload (cached in-memory)
 */
app.get('/api/webhook/apple-health/latest', (_req: Request, res: Response) => {
  res.status(200).json(latestPayload);
});

/**
 * Server-Sent Events (SSE) stream to push real-time updates to the dashboard
 */
app.get('/api/webhook/apple-health/stream', (req: Request, res: Response) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');

  // Immediately send connection confirmation and cached data
  res.write(`data: ${JSON.stringify({ type: 'connected', data: latestPayload })}\n\n`);

  const client: SSEClient = {
    id: Date.now(),
    res,
  };

  sseClients.push(client);

  // Remove connection on client disconnect
  req.on('close', () => {
    sseClients = sseClients.filter((c) => c.id !== client.id);
  });
});

/**
 * Primary webhook receiver endpoint for Apple Health data
 */
app.post(
  '/api/webhook/apple-health',
  authenticateApiKey as express.RequestHandler,
  (req: Request, res: Response) => {
    const payload = req.body as AppleHealthPayload;

    // Basic Validation
    if (!payload || !payload.timestamp || !payload.metrics) {
      res.status(400).json({
        error: 'Bad Request',
        message: 'Invalid payload structure. Requires at least "timestamp" and "metrics".',
      });
      return;
    }

    const { timestamp, device = 'Unknown iOS Device', metrics, workouts = [] } = payload;

    // Log the data in a beautiful, structured format (simulating DB insertion)
    console.log('\n================================================================');
    console.log('📱 APPLE HEALTH DATA RELAY WEBHOOK RECEIVED');
    console.log(`⏰ Device Time:   ${timestamp}`);
    console.log(`💻 Device Source: ${device}`);
    console.log(`🔌 Server Time:   ${new Date().toISOString()}`);
    console.log('----------------------------------------------------------------');
    console.log('📊 TELEMETRY METRICS:');

    // Print core metrics with nice unit formatting
    if (metrics.steps) {
      console.log(`  👣 Steps:         ${metrics.steps.value.toLocaleString()} ${metrics.steps.unit}`);
    } else {
      console.log('  👣 Steps:         No data provided');
    }

    if (metrics.activeEnergy) {
      console.log(`  🔥 Active Energy: ${metrics.activeEnergy.value.toFixed(1)} ${metrics.activeEnergy.unit}`);
    } else {
      console.log('  🔥 Active Energy: No data provided');
    }

    // Print other dynamic metrics in the payload (if any)
    Object.keys(metrics).forEach((key) => {
      if (key !== 'steps' && key !== 'activeEnergy') {
        const metric = metrics[key];
        if (metric) {
          console.log(`  📈 ${key.charAt(0).toUpperCase() + key.slice(1)}: ${metric.value} ${metric.unit}`);
        }
      }
    });

    console.log('----------------------------------------------------------------');
    console.log(`🏃 WORKOUTS (${workouts.length} recorded):`);

    if (workouts.length === 0) {
      console.log('  No workout sessions reported in this payload.');
    } else {
      workouts.forEach((workout, index) => {
        const durationMin = Math.round(workout.durationSeconds / 60);
        console.log(`  [${index + 1}] ${workout.type}`);
        console.log(`      Duration: ${durationMin} mins (${workout.durationSeconds} seconds)`);
        console.log(`      Start:    ${workout.startDate}`);
        console.log(`      End:      ${workout.endDate}`);

        if (workout.activeEnergyBurned) {
          console.log(`      Energy:   ${workout.activeEnergyBurned.value.toFixed(1)} ${workout.activeEnergyBurned.unit}`);
        }
        if (workout.distance) {
          console.log(`      Distance: ${workout.distance.value.toFixed(2)} ${workout.distance.unit}`);
        }
      });
    }
    console.log('================================================================\n');

    // Cache the latest payload in memory
    latestPayload = payload;

    // Broadcast the update to all connected dashboard client streams
    sseClients.forEach((client) => {
      try {
        client.res.write(`data: ${JSON.stringify({ type: 'update', data: payload })}\n\n`);
      } catch (err) {
        console.error('Failed to write to client SSE stream:', err);
      }
    });

    // Respond back to the Shortcut to confirm receipt
    res.status(200).json({
      success: true,
      message: 'Apple Health data relayed and processed successfully.',
      receivedAt: new Date().toISOString(),
      summary: {
        stepsReceived: !!metrics.steps,
        energyReceived: !!metrics.activeEnergy,
        workoutsLogged: workouts.length,
      },
    });
  }
);

// ==========================================
// Error Handling Middleware
// ==========================================

app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  console.error('🔥 Server Error Catch-all:');
  console.error(err.stack || err.message);

  res.status(500).json({
    error: 'Internal Server Error',
    message: process.env.NODE_ENV === 'development' ? err.message : 'An unexpected error occurred.',
  });
});

// ==========================================
// Start Server
// ==========================================
app.listen(PORT, () => {
  console.log('================================================================');
  console.log(`🚀 HealthKit Relay Webhook Server is running on port ${PORT}`);
  console.log(`📡 URL: http://localhost:${PORT}`);
  console.log(`🔒 Authentication: Bearer Token Enabled`);
  console.log(`🔧 Node Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log('================================================================');
});
