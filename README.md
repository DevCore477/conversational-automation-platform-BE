# AI Powered Conversational platform

**AI Powered Conversational platform** is an AI-powered communication and customer engagement platform designed to automate business conversations across **phone calls, WhatsApp, and messaging channels**.

It enables businesses to create intelligent AI agents, manage inbound and outbound calls, automate customer support, handle bookings and inquiries, run campaigns, and integrate AI conversations directly into their existing systems.

AI Powered Conversational platform combines **Twilio**, **ElevenLabs**, **OpenAI**, **NestJS**, and real-time communication technologies to provide scalable AI-powered customer interactions.

---

## Why AI Powered Conversational platform Matters

Businesses spend significant time handling repetitive customer conversations such as inquiries, bookings, confirmations, follow-ups, support requests, and outbound calls.

AI Powered Conversational platform automates these interactions while maintaining natural and personalized communication.

It helps businesses:

* Reduce repetitive manual work
* Respond to customers faster
* Handle multiple conversations simultaneously
* Provide 24/7 customer support
* Reduce operational costs
* Automate bookings and customer inquiries
* Scale customer communication without increasing staff
* Maintain consistent customer experiences

---

# Core Features

## AI Voice Agents

Create intelligent AI agents capable of handling natural phone conversations.

Agents can be configured with:

* Custom instructions
* AI prompts
* Conversation flows
* Scripts
* Voice selection
* Language
* Response behavior
* Business knowledge
* Call transfer rules

---

## Inbound Calls

AI Powered Conversational platform can automatically answer incoming customer calls.

The AI agent can:

* Greet customers
* Understand their request
* Answer questions
* Collect information
* Create bookings
* Verify information
* Transfer calls when required
* Complete predefined workflows

---

## Outbound Calls

Businesses can initiate AI-powered outbound calls for:

* Customer follow-ups
* Appointment reminders
* Booking confirmations
* Lead qualification
* Customer surveys
* Sales outreach
* Notifications
* Customer engagement campaigns

Outbound calls can use custom agents, scripts, flows, and voice configurations.

---

## Conversation Flows

AI Powered Conversational platform supports structured conversation flows for businesses that need predictable and controlled customer interactions.

Example flow:

```text
Greeting
   ↓
Understand Customer Intent
   ↓
Ask Required Questions
   ↓
Validate Information
   ↓
Perform Business Action
   ↓
Confirm Result
   ↓
Close Conversation
```

Flows can contain different conversational steps and business actions.

---

## Conversation Scripts

Scripts allow businesses to define how an AI agent should communicate during specific conversations.

Scripts can control:

* Introduction
* Questions
* Response style
* Business information
* Objection handling
* Confirmation messages
* Closing messages

---

## Flexible & Controlled AI Execution

Agents can support different execution behaviors.

### Flex Mode

Allows the AI agent to communicate more naturally while following the overall conversation objective.

### Rigid Mode

Ensures the AI follows predefined scripts or conversation flows more strictly.

This allows businesses to choose between natural AI conversations and highly controlled workflows.

---

## WhatsApp & Messaging Automation

AI Powered Conversational platform can also support AI-powered messaging conversations.

Businesses can use AI agents for:

* Customer inquiries
* Support conversations
* Booking requests
* Lead qualification
* Follow-ups
* Automated responses
* Notifications

This allows businesses to manage both voice and messaging interactions from the same platform.

---

## Campaign Management

AI Powered Conversational platform supports outbound communication campaigns.

Campaign features can include:

* Bulk customer communication
* CSV contact import
* Agent selection
* Template selection
* Campaign progress tracking
* Sent / failed / completed statistics
* Customer status tracking

Campaigns help businesses communicate with large groups of customers efficiently.

---

## Call Queue Management

AI Powered Conversational platform includes queue management for inbound and outbound calls.

Instead of processing calls one-by-one, calls can be queued and processed according to available system capacity.

Queue management helps support:

* Multiple concurrent calls
* Controlled call processing
* Call retries
* Worker-based processing
* Queue pause and resume
* Queue monitoring
* Failed call handling
* Queue metrics

---

## Conversation History

All customer conversations can be recorded and tracked.

Conversation history can contain:

* Customer phone number
* Call direction
* Call status
* Agent
* Conversation transcript
* Call duration
* Start and end time
* Conversation metadata
* AI responses
* Customer responses

This allows businesses to review previous interactions and improve customer service.

---

## Call Analytics & Queue Metrics

AI Powered Conversational platform can provide operational insights into calling activity.

Example metrics include:

* Total calls
* Active calls
* Completed calls
* Failed calls
* Incoming calls
* Outgoing calls
* Waiting calls
* Queue size
* Processing calls
* Average call duration
* Call success rate

These metrics help businesses understand AI agent performance and system usage.

---

## Role-Based Access

AI Powered Conversational platform supports role-based access for organizations.

Example roles include:

### Admin

Admins can manage:

* AI agents
* Team members
* Calls
* Campaigns
* Conversation flows
* Scripts
* Integrations
* Analytics
* Company settings

### Team Members

Team members can access features based on permissions assigned by the organization.

---

## Business Integrations

AI Powered Conversational platform can connect with external business systems and APIs.

Possible integrations include:

* Booking systems
* CRM platforms
* Order management systems
* Customer databases
* WhatsApp
* Twilio
* ElevenLabs
* OpenAI
* Internal company APIs

This allows AI agents to perform real business actions instead of only answering questions.

---

# System Architecture

```text
                          ┌─────────────────────┐
                          │      Customer       │
                          └──────────┬──────────┘
                                     │
                  ┌──────────────────┴──────────────────┐
                  │                                     │
               Phone                                 WhatsApp
                  │                                     │
                  ▼                                     ▼
               Twilio                              Messaging API
                  │                                     │
                  └──────────────────┬──────────────────┘
                                     │
                                     ▼
                ┌─────────────────────────────────────────────┐
                │     AI Powered Conversational platform      │
                │              NestJS Backend                 │
                └────────────────────┬────────────────────────┘
                                     │
                ┌────────────────────┼────────────────────┐
                │                    │                    │
                ▼                    ▼                    ▼
          AI Agent Engine      Queue System         Business APIs
                │
                ▼
       ElevenLabs / OpenAI
                │
                ▼
       Conversation Engine
                │
                ▼
           PostgreSQL DB
```

---

# Voice Call Architecture

```text
Incoming / Outgoing Call
          ↓
        Twilio
          ↓
        Webhook
          ↓
     NestJS Backend
          ↓
   WebSocket Gateway
          ↓
   ElevenLabs Agent
          ↓
 Conversation Engine
          ↓
   Business Logic/API
          ↓
      PostgreSQL
```

---

# Technology Stack

## Backend

* **NestJS** – Backend framework
* **TypeScript** – Programming language
* **Node.js** – Runtime environment

## AI

* **ElevenLabs** – Conversational AI and voice
* **OpenAI** – AI reasoning and language processing

## Communication

* **Twilio** – Phone call infrastructure
* **WebSocket** – Real-time audio streaming
* **WhatsApp APIs** – Messaging automation

## Database

* **PostgreSQL** – Primary database
* **TypeORM** – Database ORM

## Authentication

* **JWT** – API authentication
* **Role-Based Access Control** – Organization permissions

## Documentation

* **Swagger / OpenAPI** – API documentation

---

# Setup Instructions

## 1. Environment Variables

Create a `.env` file inside the application directory.

```env
# ==========================================
# Application
# ==========================================

PORT=3000

APP_BASE_URL=http://localhost:3000

WEBHOOK_BASE_URL=https://your-domain.com


# ==========================================
# Twilio
# ==========================================

TWILIO_ACCOUNT_SID=ACxxxxxxxxxxxxxxxxxxxxxxxxxxxx

TWILIO_AUTH_TOKEN=your_auth_token

TWILIO_PHONE_NUMBER=+1234567890


# ==========================================
# ElevenLabs
# ==========================================

ELEVENLABS_API_KEY=your_elevenlabs_api_key

ELEVENLABS_AGENT_ID=your_agent_id

ELEVENLABS_BASE_URL=https://api.elevenlabs.io/v1


# ==========================================
# AI
# ==========================================

OPENAI_API_KEY=your_openai_api_key

OPENAI_BASE_URL=https://api.openai.com/v1


# ==========================================
# Inbound Call Defaults
# ==========================================

INBOUND_CALL_SCRIPT="You are a professional AI customer service agent. Greet the caller and assist them with their request."

INBOUND_CALL_MODEL=gpt-4


# ==========================================
# PostgreSQL
# ==========================================

DATABASE_URL=postgresql://user:password@localhost:5432/hexa_ai

DATABASE_HOST=localhost

DATABASE_PORT=5432

DATABASE_USERNAME=your_username

DATABASE_PASSWORD=your_password

DATABASE_NAME=hexa_ai

DATABASE_SSL=false

DATABASE_SYNCHRONIZE=true


# ==========================================
# Authentication
# ==========================================

JWT_SECRET=your_secure_jwt_secret

JWT_EXPIRES_IN=7d


# ==========================================
# Email
# ==========================================

SENDGRID_API_KEY=your_sendgrid_api_key

SENDGRID_FROM_EMAIL=noreply@yourdomain.com

SENDGRID_FROM_NAME=AI Powered Conversational platform
```

> Never commit production credentials or `.env` files to the repository.

---

# Installation

Install project dependencies:

```bash
npm install
```

---

# Running the Application

## Development

```bash
npm run start:dev
```

## Production Build

```bash
npm run build
```

Start production application:

```bash
npm run start:prod
```

---

# Local Webhook Development

Twilio requires publicly accessible webhook endpoints.

For local development, you can use ngrok:

```bash
ngrok http 3000
```

Example:

```text
https://example.ngrok-free.app
```

Update your environment variable:

```env
WEBHOOK_BASE_URL=https://example.ngrok-free.app
```

---

# Twilio Configuration

To connect a Twilio number with AI Powered Conversational platform:

1. Open the Twilio Console
2. Navigate to:

```text
Phone Numbers
→ Manage
→ Active Numbers
```

3. Select the required phone number.

4. Open **Voice Configuration**.

5. Configure **A Call Comes In**.

Example:

```text
Webhook:
https://your-domain.com/webhook/inbound

Method:
POST
```

6. Save the configuration.

---

# API Endpoints

## Public Webhooks

### POST `/webhook/inbound`

Handles incoming calls from Twilio.

Example Twilio payload:

```json
{
  "CallSid": "CAxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
  "From": "+1234567890",
  "To": "+0987654321",
  "CallStatus": "ringing"
}
```

The endpoint responds with TwiML used to establish the voice stream.

---

### POST `/webhook/voice-agent`

Handles voice-agent initialization for outbound calls.

---

### POST `/webhook/gather`

Handles speech recognition results for supported non-streaming workflows.

---

# Calls API

Calls APIs require authentication.

Use:

```text
Authorization: Bearer <JWT_TOKEN>
```

---

## POST `/calls`

Create an outbound call.

Example request:

```json
{
  "to": "+1234567890",
  "script": "You are a customer service representative following up on a customer request.",
  "model": "gpt-4"
}
```

Example response:

```json
{
  "success": true,
  "callSid": "CAxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
  "status": "connecting"
}
```

---

## GET `/calls`

Returns the available call records for the authenticated user/company.

---

## GET `/calls/:callSid`

Returns information for a specific call.

---

# Authentication

## POST `/auth/register`

Registers a new AI Powered Conversational platform account.

---

## POST `/auth/login`

Authenticates a user and returns an access token.

Example:

```json
{
  "email": "user@example.com",
  "password": "password"
}
```

---

# Real-Time WebSocket

## WS `/ws/twilio-audio`

Handles real-time voice streaming between Twilio and the AI voice provider.

Typical flow:

```text
Twilio
   ↓
Start Event
   ↓
AI Powered Conversational platform WebSocket Gateway
   ↓
ElevenLabs WebSocket
   ↓
AI Conversation
   ↓
Audio Response
   ↓
Twilio
```

---

## WebSocket Lifecycle

### 1. Twilio Start Event

Twilio establishes the audio stream and provides:

* Call SID
* Stream SID
* Call metadata

### 2. AI Connection

AI Powered Conversational platform connects the call to the configured ElevenLabs AI agent.

### 3. Real-Time Audio

Customer and AI audio are streamed bidirectionally.

### 4. Conversation Processing

The AI agent processes:

* Customer speech
* Agent instructions
* Scripts
* Conversation flows
* Business actions

### 5. Stop Event

When the call ends, the stream is closed and the final call state is stored.

---

# Audio Processing

AI Powered Conversational platform handles audio transformation required between providers.

Example:

```text
Twilio Audio
µ-law 8kHz
     ↓
AI Powered Conversational platform Audio Bridge
     ↓
AI Provider Audio Format
     ↓
ElevenLabs
```

The response follows the reverse path back to the caller.

---

# Customizing AI Agents

Agents can be configured using different instructions and conversation strategies.

Example system instruction:

```text
You are an AI customer support representative for ABC Company.

Your responsibilities are:

1. Greet the customer professionally.
2. Understand why they are calling.
3. Ask only relevant questions.
4. Answer questions using available company information.
5. Create a booking when requested.
6. Confirm all important details.
7. Transfer the call if human assistance is required.
8. End the conversation politely.
```

---

# Outbound Call Script

Example:

```json
{
  "to": "+1234567890",
  "script": "You are calling the customer regarding their recent booking. Confirm the booking date and ask whether they need any assistance.",
  "model": "gpt-4"
}
```

---

# First Message

The first message can be configured for individual agents or calls.

Example:

```typescript
const callState = this.callStateService.create({
  callSid: dto.CallSid,
  phoneNumberFrom: dto.From,
  phoneNumberTo: dto.To,
  script,
  model,
  provider: 'twilio+elevenlabs',
  status: 'connecting',
  metadata: {
    firstMessage:
      'Hello! Thank you for calling. How can I help you today?',
  },
});
```

---

# Call State Management

AI Powered Conversational platform maintains call state throughout the call lifecycle.

Example lifecycle:

```text
Initiating
    ↓
Queued
    ↓
Connecting
    ↓
Active
    ↓
Completed
```

Failure states may include:

```text
Failed
Busy
No Answer
Cancelled
```

Call state information can be stored for history, analytics, debugging, and reporting.

---

# Queue Processing

Outbound calls can be processed through a queue to control concurrent calls.

Example:

```text
Outbound Call Request
        ↓
     Call Queue
        ↓
 Available Worker
        ↓
     Twilio Call
        ↓
      AI Agent
```

The queue can help prevent system overload and manage provider concurrency limits.

---

# Queue Operations

Depending on the configured implementation, supported operations can include:

```text
Add Job
Process Job
Retry Job
Pause Queue
Resume Queue
Remove Job
Inspect Queue
```

Queue metrics can include:

```text
Waiting Jobs
Active Jobs
Completed Jobs
Failed Jobs
Delayed Jobs
Paused State
```

---

# Monitoring & Logging

AI Powered Conversational platform provides logs for call processing and debugging.

Example log events:

```text
📞 Inbound call received

✅ Call state created

📥 Call added to queue

🔥 Twilio WebSocket connected

🤖 ElevenLabs WebSocket connected

📝 AI agent initialized

📊 Call state updated

⏹ Call ended
```

Production environments should use centralized logging and monitoring where possible.

---

# Error Handling

Important failure scenarios include:

* Twilio connection errors
* ElevenLabs API failures
* AI provider errors
* Invalid phone numbers
* WebSocket disconnections
* Database failures
* Queue failures
* Provider limits
* Authentication failures
* Business integration failures

Errors should be logged with enough information to diagnose the issue without exposing sensitive credentials or customer data.

---

# Troubleshooting

## Call Connects but No Audio

Check:

* `WEBHOOK_BASE_URL`
* WebSocket configuration
* Twilio Media Streams
* ElevenLabs credentials
* Audio conversion
* Reverse proxy WebSocket support
* Firewall rules

---

## Call State Is Missing

A WebSocket connection may occasionally establish before the corresponding call state is available.

Ensure the gateway has appropriate retry handling before failing the connection.

---

## ElevenLabs Connection Fails

Check:

```text
ELEVENLABS_API_KEY
ELEVENLABS_AGENT_ID
ELEVENLABS_BASE_URL
```

Also verify:

* ElevenLabs API quota
* Agent status
* Account permissions
* Conversational AI configuration

---

## Twilio Webhook Is Not Triggered

Check:

* Twilio webhook URL
* HTTPS availability
* HTTP method
* Application logs
* Twilio debugger
* DNS configuration
* Reverse proxy configuration

---

## Outbound Calls Are Not Processing

Check:

* Queue status
* Queue pause state
* Worker availability
* Twilio account limits
* Phone number configuration
* Failed jobs
* Provider rate limits

---

# Security

Important security practices:

* Never expose API keys
* Never commit `.env` files
* Use strong JWT secrets
* Validate incoming webhook requests
* Use HTTPS in production
* Protect authenticated endpoints
* Implement company-level data isolation
* Apply role-based permissions
* Encrypt sensitive customer information where required
* Avoid logging secrets and sensitive customer information
* Rotate provider credentials regularly

---

# API Documentation

Swagger API documentation is available when the server is running.

```text
http://localhost:3000/api
```

Production environments should restrict Swagger access if the APIs contain sensitive administrative functionality.

---

# Development Commands

## Build

```bash
npm run build
```

## Development Server

```bash
npm run start:dev
```

## Production

```bash
npm run start:prod
```

## Lint

```bash
npm run lint
```

## Format

```bash
npm run format
```

---

# Main AI Powered Conversational platform Modules

The overall platform can contain the following modules:

```text
Authentication
Companies
Users & Teams
AI Agents
Conversation Flows
Scripts
Voice Configuration
Inbound Calls
Outbound Calls
Call Queue
Campaigns
Conversation History
WhatsApp
Integrations
Analytics
Notifications
Company Settings
```

---

# Example Business Use Cases

AI Powered Conversational platform can be adapted to different industries.

### Restaurants

* Table bookings
* Order inquiries
* Reservation confirmations

### Healthcare

* Appointment scheduling
* Appointment reminders
* General patient inquiries

### Logistics & Courier

* Delivery bookings
* Shipment inquiries
* Customer updates

### Transport

* Ride bookings
* Booking confirmations
* Passenger support

### Real Estate

* Lead qualification
* Property inquiries
* Viewing appointments

### Recruitment

* Candidate screening
* Interview scheduling
* Candidate follow-ups

### Customer Support

* Frequently asked questions
* Complaint collection
* Ticket creation
* Human escalation

### Sales

* Lead qualification
* Follow-up calls
* Product inquiries
* Campaign outreach

---

# Project Vision

AI Powered Conversational platform aims to become a unified AI communication platform where businesses can deploy intelligent agents across voice and messaging channels without building complex AI infrastructure themselves.

The platform is designed around three principles:

**Automate** repetitive customer interactions.

**Integrate** AI directly with real business systems.

**Scale** customer communication without increasing operational complexity.

---

# License

```text
UNLICENSED
```

Copyright © AI Powered Conversational platform. All rights reserved.
