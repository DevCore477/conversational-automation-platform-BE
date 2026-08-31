/**
 * Test ElevenLabs WebSocket Connection
 * 
 * This script tests if you can connect to ElevenLabs API
 * Run: node test-elevenlabs-connection.js
 */

const WebSocket = require('ws');
require('dotenv').config();

const agentId = process.env.ELEVENLABS_AGENT_ID;
const apiKey = process.env.ELEVENLABS_API_KEY;

if (!agentId || !apiKey) {
  console.error('❌ Missing ELEVENLABS_AGENT_ID or ELEVENLABS_API_KEY in .env file');
  process.exit(1);
}

console.log('🔍 Testing ElevenLabs connection...');
console.log(`Agent ID: ${agentId}`);
console.log(`API Key: ${apiKey.substring(0, 10)}...`);
console.log('');

const wsUrl = `wss://api.elevenlabs.io/v1/convai/conversation?agent_id=${agentId}`;
console.log(`Connecting to: ${wsUrl}`);
console.log('');

const ws = new WebSocket(wsUrl, {
  headers: {
    'xi-api-key': apiKey,
  },
  handshakeTimeout: 10000,
  rejectUnauthorized: false, // Allow self-signed certs
});

let connected = false;

ws.on('open', () => {
  console.log('✅ SUCCESS! Connected to ElevenLabs WebSocket!');
  console.log('');
  connected = true;
  
  // Send initialization message
  const initMessage = {
    type: 'conversation_initiation_client_data',
    conversation_config_override: {
      agent: {
        prompt: {
          prompt: 'You are a test assistant.',
        },
        first_message: 'Hello! This is a test.',
        language: 'en',
      },
    },
  };
  
  console.log('📤 Sending initialization message...');
  ws.send(JSON.stringify(initMessage));
});

ws.on('message', (data) => {
  try {
    const message = JSON.parse(data.toString());
    console.log('📥 Received message type:', message.type);
    
    if (message.type === 'conversation_initiation_metadata') {
      console.log('✅ Agent initialized successfully!');
      console.log('');
      console.log('🎉 Your ElevenLabs connection is working!');
      console.log('You can now use the calling bot.');
      ws.close();
      process.exit(0);
    }
  } catch (e) {
    console.log('📥 Received data:', data.toString().substring(0, 100));
  }
});

ws.on('error', (error) => {
  console.error('❌ CONNECTION FAILED!');
  console.error('');
  console.error('Error details:', error.message);
  console.error('Error code:', error.code);
  console.error('');
  
  if (error.code === 'ENETUNREACH' || error.code === 'ENOTFOUND') {
    console.error('🔧 SOLUTION:');
    console.error('');
    console.error('This is a network/SSL certificate issue. Try these fixes:');
    console.error('');
    console.error('1. Add this line to your .env file:');
    console.error('   NODE_TLS_REJECT_UNAUTHORIZED=0');
    console.error('');
    console.error('2. Install/update SSL certificates:');
    console.error('   brew install ca-certificates');
    console.error('');
    console.error('3. Check if you can reach ElevenLabs:');
    console.error('   curl https://api.elevenlabs.io/v1/user');
    console.error('');
    console.error('See FIX_SSL_ISSUE.md for more solutions.');
  } else if (error.code === 'ECONNREFUSED') {
    console.error('🔧 SOLUTION:');
    console.error('Connection refused. Check your firewall or VPN settings.');
  } else {
    console.error('🔧 SOLUTION:');
    console.error('Check FIX_SSL_ISSUE.md for troubleshooting steps.');
  }
  
  process.exit(1);
});

ws.on('close', () => {
  if (!connected) {
    console.error('❌ Connection closed before establishing.');
    console.error('Check the error message above for details.');
    process.exit(1);
  }
});

// Timeout after 15 seconds
setTimeout(() => {
  if (!connected) {
    console.error('❌ Connection timeout after 15 seconds');
    console.error('');
    console.error('🔧 SOLUTION:');
    console.error('This might be a firewall or network issue.');
    console.error('See FIX_SSL_ISSUE.md for troubleshooting steps.');
    ws.close();
    process.exit(1);
  }
}, 15000);

