# ld_test

A very basic Node.js application with both server-side and HTML frontend.

## Features

- Express.js server
- Static HTML frontend
- API endpoint for server-client communication

## Installation

```bash
npm install
```

## Usage

Start the server:

```bash
npm start
```

Create a `.env` file with the required keys:

```bash
GEMINI_API_KEY=your-gemini-api-key

# Optional
GEMINI_MODEL=gemini-pro
PORT=3001
```

The application will be available at `http://localhost:3001`

## API Endpoints

- `GET /api/message` - Returns a JSON message from the server

## Project Structure

- `server.js` - Express server with API endpoints
- `public/index.html` - HTML frontend with JavaScript
- `package.json` - Node.js project configuration
