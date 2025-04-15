const express = require('express');
const mysql = require('mysql2/promise');
const redis = require('redis');
const app = express();
const port = 3000;

// MySQL connection
const db = mysql.createPool({
  host: 'localhost',
  user: 'root',
  password: 'Certiorari@1234', // Replace with your MySQL password
  database: 'flow'
});

// Redis clients
const redisClient = redis.createClient({ url: 'redis://localhost:6379' });
const redisPublisher = redis.createClient({ url: 'redis://localhost:6379' });
const redisSubscriber = redis.createClient({ url: 'redis://localhost:6379' });
redisClient.connect().catch(console.error);
redisPublisher.connect().catch(console.error);
redisSubscriber.connect().catch(console.error);



// Middleware
app.use(express.static('public'));
app.use(express.json());

// Fetch flow data
app.get('/flow/:flowId', async (req, res) => {
  const { flowId } = req.
  
  params;
  const [rows] = await db.query('SELECT * FROM workflows WHERE flow_id = ?', [flowId]);
  if (rows.length === 0) return res.status(404).send('Flow not found');
  const flow = rows[0];
  await redisClient.set(`flow:${flowId}:lastmodified`, flow.last_modified.toISOString());
  res.json(flow);
});

// SSE endpoint
app.get('/events/:flowId', async (req, res) => {
  const { flowId } = req.params;
  const sessionId = req.query.sessionId;
  if (!sessionId) return res.status(400).send('Session ID required');

  // Set SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  // Store connection

  // Add sessionId to Redis list
  await redisClient.lPush(`flow:${flowId}`, sessionId);

  // Subscribe to Redis channel
  await redisSubscriber.subscribe(`flow:${flowId}`, async (message) => {
    const data = JSON.parse(message);
    if (data.targetSessionId === sessionId && data.sessionId !== sessionId) {
      res.write(`data: ${JSON.stringify(data.payload)}\n\n`);
    }
  });

  // Clean up on disconnect
  req.on('close', async () => {
    await redisClient.lRem(`flow:${flowId}`, 0, sessionId);
    res.end();
    console.log(`Client ${sessionId} disconnected from flow ${flowId}`);
  });
});

// Save flow data
app.post('/flow/:flowId', async (req, res) => {
  const { flowId } = req.params;
  const { flowData, username, sessionId } = req.body;

  const [current] = await db.query('SELECT flow_data FROM workflows WHERE flow_id = ?', [flowId]);
  if (JSON.stringify(current[0].flow_data) === JSON.stringify(flowData)) {
    return res.json({ message: 'No changes detected' });
  }

  const lastModified = new Date()
  await db.query(
    'UPDATE workflows SET flow_data = ?, last_modified = ?, last_modified_by = ? WHERE flow_id = ?',
    [JSON.stringify(flowData), lastModified, username, flowId]
  );
  // await redisClient.set(`flow:${flowId}:lastmodified`, lastModified);

  // Get all session IDs
  const sessionIds = await redisClient.lRange(`flow:${flowId}`, 0, -1);
  const payload = {
    message: `The flow has been updated by ${username}. Please refresh.`,
    lastModified
  };

  // Publish to other session IDs
  for (const targetSessionId of sessionIds) {
    if (targetSessionId !== sessionId) {
      await redisPublisher.publish(
        `flow:${flowId}`,
        JSON.stringify({ sessionId, targetSessionId, payload })
      );
    }
  }

  res.json({ message: 'Flow updated', lastModified });
});

app.listen(port, () => console.log(`Server running at http://localhost:${port}`));