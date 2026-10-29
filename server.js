import express from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { handler as ssrHandler } from './dist/server/entry.mjs';

const app = express();

// Trust reverse proxies (Cloudflare, Nginx, hosting platforms)
app.set('trust proxy', 1);

// Remove fingerprinting header
app.disable('x-powered-by');

// 1. Helmet Security Middleware
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'"],
        styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
        fontSrc: ["'self'", 'https://fonts.gstatic.com'],
        imgSrc: ["'self'", 'data:', 'blob:'],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
      },
    },
    crossOriginEmbedderPolicy: false,
    crossOriginResourcePolicy: { policy: 'same-origin' },
  })
);

// 2. Global Rate Limiter (DDoS and abuse prevention)
const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 600,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'تم تجاوز الحد المسموح من الطلبات، يرجى المحاولة لاحقاً.' },
});
app.use(globalLimiter);

// 3. Strict Rate Limiter for Login Endpoint
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'تم تجاوز الحد المسموح لمحاولات الدخول، يرجى المحاولة بعد 15 دقيقة.' },
});
app.use('/api/auth/login', loginLimiter);

// Serve static assets from 'dist/client'
app.use(express.static('dist/client'));

// Use Astro SSR handler for all other requests
app.use(ssrHandler);

const port = process.env.PORT || 8080;
app.listen(port, () => {
  console.log(`Server listening securely on port ${port}`);
});
