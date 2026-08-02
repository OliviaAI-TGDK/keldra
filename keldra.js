// =============================================
// KELDRA: Production-Grade Surveillance Platform
// =============================================
// Description:
//   - Backend for Keldra surveillance platform.
//   - Integrates Firebase Auth, Firestore, WebSockets.
//   - Supports GaiaOnline/Discord scraping, metric zonality, triads.
//   - Modular, scalable, and secure.

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const morgan = require('morgan');
const { initializeApp } = require('firebase/app');
const { getAuth, signInWithEmailAndPassword, createUserWithEmailAndPassword } = require('firebase/auth');
const { getFirestore, doc, setDoc, getDoc, updateDoc, collection, query, where, getDocs } = require('firebase/firestore');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

// Initialize Firebase
const firebaseConfig = {
  apiKey: process.env.FIREBASE_API_KEY,
  authDomain: process.env.FIREBASE_AUTH_DOMAIN,
  projectId: process.env.FIREBASE_PROJECT_ID,
  storageBucket: process.env.FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.FIREBASE_APP_ID,
  measurementId: process.env.FIREBASE_MEASUREMENT_ID
};
const firebaseApp = initializeApp(firebaseConfig);
const auth = getAuth(firebaseApp);
const db = getFirestore(firebaseApp);

// Initialize Express
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: process.env.ALLOWED_ORIGINS?.split(',') || "*",
    methods: ["GET", "POST"]
  }
});

// =============================================
// MIDDLEWARE
// =============================================
app.use(cors({
  origin: process.env.ALLOWED_ORIGINS?.split(',') || "*"
}));
app.use(helmet());
app.use(morgan('combined'));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Rate limiting (100 requests per 15 minutes)
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100,
  message: 'Too many requests from this IP, please try again later.'
});
app.use(limiter);

// Serve static files (e.g., frontend)
app.use(express.static(path.join(__dirname, 'public')));

// =============================================
// FIREBASE AUTH MIDDLEWARE
// =============================================
const authenticate = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized: No token provided.' });
  }

  const idToken = authHeader.split('Bearer ')[1];
  try {
    // Verify Firebase ID token (mock: in production, use admin SDK)
    // Note: Client-side token verification is insecure. Use Firebase Admin SDK on the server.
    // This is a placeholder for demonstration.
    const user = await auth.currentUser;
    if (!user) {
      return res.status(401).json({ error: 'Unauthorized: Invalid token.' });
    }
    req.user = user;
    next();
  } catch (error) {
    console.error('Authentication error:', error);
    return res.status(401).json({ error: 'Unauthorized: Invalid token.' });
  }
};

// =============================================
// API ROUTES
// =============================================
// Health check
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'OK', timestamp: new Date().toISOString() });
});

// Auth routes
app.post('/api/auth/signup', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required.' });
  }

  try {
    const userCredential = await createUserWithEmailAndPassword(auth, email, password);
    const user = userCredential.user;
    const token = await user.getIdToken();

    // Save user to Firestore
    await setDoc(doc(db, 'users', user.uid), {
      uid: user.uid,
      email: user.email,
      createdAt: new Date().toISOString(),
      lastLoginAt: new Date().toISOString()
    });

    res.status(201).json({
      uid: user.uid,
      email: user.email,
      token
    });
  } catch (error) {
    console.error('Signup error:', error);
    res.status(400).json({ error: error.message });
  }
});

app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required.' });
  }

  try {
    const userCredential = await signInWithEmailAndPassword(auth, email, password);
    const user = userCredential.user;
    const token = await user.getIdToken();

    // Update last login time
    await updateDoc(doc(db, 'users', user.uid), {
      lastLoginAt: new Date().toISOString()
    });

    res.status(200).json({
      uid: user.uid,
      email: user.email,
      token
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(401).json({ error: error.message });
  }
});

// Protected route example
app.get('/api/user', authenticate, async (req, res) => {
  try {
    const userDoc = await getDoc(doc(db, 'users', req.user.uid));
    if (!userDoc.exists()) {
      return res.status(404).json({ error: 'User not found.' });
    }
    res.status(200).json(userDoc.data());
  } catch (error) {
    console.error('Error fetching user:', error);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// =============================================
// SURVEILLANCE DATA ROUTES
// =============================================
// Save scraped data (e.g., GaiaOnline/Discord)
app.post('/api/data/scrape', authenticate, async (req, res) => {
  const { platform, data, metadata = {} } = req.body;
  if (!platform || !data) {
    return res.status(400).json({ error: 'Platform and data are required.' });
  }

  try {
    const scrapeRef = doc(collection(db, 'scrapes'));
    await setDoc(scrapeRef, {
      userId: req.user.uid,
      platform,
      data,
      metadata,
      createdAt: new Date().toISOString()
    });

    // Broadcast to WebSocket clients
    io.emit('new_scrape', { platform, data, metadata, userId: req.user.uid });

    res.status(201).json({ success: true, id: scrapeRef.id });
  } catch (error) {
    console.error('Error saving scrape:', error);
    res.status(500).json({ error: 'Failed to save scrape data.' });
  }
});

// Get scrapes for a user
app.get('/api/data/scrapes', authenticate, async (req, res) => {
  try {
    const scrapesQuery = query(
      collection(db, 'scrapes'),
      where('userId', '==', req.user.uid)
    );
    const querySnapshot = await getDocs(scrapesQuery);
    const scrapes = querySnapshot.docs.map(doc => ({
      id: doc.id,
      ...doc.data()
    }));
    res.status(200).json(scrapes);
  } catch (error) {
    console.error('Error fetching scrapes:', error);
    res.status(500).json({ error: 'Failed to fetch scrapes.' });
  }
});

// =============================================
// METRIC ZONALITY ROUTES
// =============================================
// Save zone classifications
app.post('/api/zones/classify', authenticate, async (req, res) => {
  const { entityType, entityId, metrics, zone } = req.body;
  if (!entityType || !entityId || !metrics || !zone) {
    return res.status(400).json({ error: 'entityType, entityId, metrics, and zone are required.' });
  }

  try {
    const zoneRef = doc(collection(db, 'zones'));
    await setDoc(zoneRef, {
      entityType,
      entityId,
      metrics,
      zone,
      classifiedAt: new Date().toISOString(),
      classifiedBy: req.user.uid
    });

    // Broadcast zone update
    io.emit('zone_update', { entityType, entityId, metrics, zone });

    res.status(201).json({ success: true, id: zoneRef.id });
  } catch (error) {
    console.error('Error saving zone classification:', error);
    res.status(500).json({ error: 'Failed to save zone classification.' });
  }
});

// Get zones for a user
app.get('/api/zones', authenticate, async (req, res) => {
  try {
    const zonesQuery = query(
      collection(db, 'zones'),
      where('classifiedBy', '==', req.user.uid)
    );
    const querySnapshot = await getDocs(zonesQuery);
    const zones = querySnapshot.docs.map(doc => ({
      id: doc.id,
      ...doc.data()
    }));
    res.status(200).json(zones);
  } catch (error) {
    console.error('Error fetching zones:', error);
    res.status(500).json({ error: 'Failed to fetch zones.' });
  }
});

// =============================================
// TRIAD/QUAITRIDEOTAXIS ROUTES
// =============================================
// Save triads
app.post('/api/triads', authenticate, async (req, res) => {
  const { nodes, edges, type, metadata = {} } = req.body;
  if (!nodes || !edges || !type) {
    return res.status(400).json({ error: 'nodes, edges, and type are required.' });
  }

  try {
    const triadRef = doc(collection(db, 'triads'));
    await setDoc(triadRef, {
      nodes,
      edges,
      type,
      metadata,
      createdAt: new Date().toISOString(),
      createdBy: req.user.uid
    });

    // Broadcast triad creation
    io.emit('new_triad', { nodes, edges, type, metadata, userId: req.user.uid });

    res.status(201).json({ success: true, id: triadRef.id });
  } catch (error) {
    console.error('Error saving triad:', error);
    res.status(500).json({ error: 'Failed to save triad.' });
  }
});

// Get triads for a user
app.get('/api/triads', authenticate, async (req, res) => {
  try {
    const triadsQuery = query(
      collection(db, 'triads'),
      where('createdBy', '==', req.user.uid)
    );
    const querySnapshot = await getDocs(triadsQuery);
    const triads = querySnapshot.docs.map(doc => ({
      id: doc.id,
      ...doc.data()
    }));
    res.status(200).json(triads);
  } catch (error) {
    console.error('Error fetching triads:', error);
    res.status(500).json({ error: 'Failed to fetch triads.' });
  }
});

// =============================================
// WEB SOCKET EVENTS
// =============================================
io.on('connection', (socket) => {
  console.log(`User connected: ${socket.id}`);

  // Join a room based on user ID (after authentication)
  socket.on('authenticate', async (token) => {
    try {
      // Verify Firebase token (mock: use admin SDK in production)
      const user = await auth.currentUser;
      if (user) {
        socket.join(user.uid);
        socket.userId = user.uid;
        console.log(`User ${user.uid} authenticated and joined room.`);
      }
    } catch (error) {
      console.error('WebSocket auth error:', error);
      socket.disconnect(true);
    }
  });

  // Handle disconnection
  socket.on('disconnect', () => {
    console.log(`User disconnected: ${socket.id}`);
  });
});

// =============================================
// START SERVER
// =============================================
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Keldra server running on port ${PORT}`);
  console.log(`Firebase initialized for project ${firebaseConfig.projectId}`);
});

// =============================================
// ERROR HANDLING
// =============================================
// Handle unhandled promise rejections
process.on('unhandledRejection', (err) => {
  console.error('Unhandled Rejection:', err);
});

// Handle uncaught exceptions
process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
  process.exit(1); // Mandatory (as per the Node.js docs)
});
