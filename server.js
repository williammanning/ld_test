import dotenv from 'dotenv';
import { GoogleGenerativeAI } from '@google/generative-ai';
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3001;
const geminiApiKey = process.env.GEMINI_API_KEY;
const geminiModel = process.env.GEMINI_MODEL || 'gemini-pro';

const normalizeModelName = (name) => name.replace(/^models\//, '');
const renderPrompt = (messages) =>
  messages.map((entry) => `${entry.role}: ${entry.content}`).join('\n');
const SAN_JOSE = {
  name: 'San Jose, CA',
  latitude: 37.3382,
  longitude: -121.8863,
};
const WEATHER_CODE_LABELS = {
  0: 'Clear sky',
  1: 'Mainly clear',
  2: 'Partly cloudy',
  3: 'Overcast',
  45: 'Fog',
  48: 'Depositing rime fog',
  51: 'Light drizzle',
  53: 'Moderate drizzle',
  55: 'Dense drizzle',
  56: 'Light freezing drizzle',
  57: 'Dense freezing drizzle',
  61: 'Slight rain',
  63: 'Moderate rain',
  65: 'Heavy rain',
  66: 'Light freezing rain',
  67: 'Heavy freezing rain',
  71: 'Slight snow',
  73: 'Moderate snow',
  75: 'Heavy snow',
  77: 'Snow grains',
  80: 'Slight rain showers',
  81: 'Moderate rain showers',
  82: 'Violent rain showers',
  85: 'Slight snow showers',
  86: 'Heavy snow showers',
  95: 'Thunderstorm',
  96: 'Thunderstorm with slight hail',
  99: 'Thunderstorm with heavy hail',
};

const weatherCodeToLabel = (code) => WEATHER_CODE_LABELS[code] || 'Unknown conditions';

const fetchNwsCyclingSignal = async () => {
  const headers = {
    'User-Agent': 'ld_test weather demo (local development)',
    Accept: 'application/geo+json',
  };
  const pointsUrl = `https://api.weather.gov/points/${SAN_JOSE.latitude},${SAN_JOSE.longitude}`;
  const pointsResponse = await fetch(pointsUrl, { headers });
  if (!pointsResponse.ok) {
    throw new Error(`weather.gov points lookup failed: ${pointsResponse.status}`);
  }

  const pointsData = await pointsResponse.json();
  const forecastUrl = pointsData?.properties?.forecast;
  if (!forecastUrl) {
    throw new Error('weather.gov points response is missing forecast URL');
  }

  const forecastResponse = await fetch(forecastUrl, { headers });
  if (!forecastResponse.ok) {
    throw new Error(`weather.gov forecast lookup failed: ${forecastResponse.status}`);
  }

  const forecastData = await forecastResponse.json();
  const periods = Array.isArray(forecastData?.properties?.periods)
    ? forecastData.properties.periods
    : [];
  const dayPeriod = periods.find((period) => period?.isDaytime) || periods[0];
  const summary = [dayPeriod?.shortForecast, dayPeriod?.detailedForecast]
    .filter(Boolean)
    .join(' ')
    .trim();

  const lowered = summary.toLowerCase();
  let scoreDelta = 0;
  if (/thunder|storm|hail/.test(lowered)) {
    scoreDelta -= 35;
  }
  if (/rain|showers|drizzle/.test(lowered)) {
    scoreDelta -= 20;
  }
  if (/windy|gust/.test(lowered)) {
    scoreDelta -= 10;
  }
  if (/clear|sunny|fair/.test(lowered)) {
    scoreDelta += 8;
  }

  return {
    source: 'weather.gov',
    summary: summary || 'No summary available.',
    scoreDelta,
  };
};

const getBicyclingRecommendation = ({ current, today, nwsSignal }) => {
  let score = 100;
  const reasons = [];

  if (today.precipChance >= 65) {
    score -= 35;
    reasons.push('high rain chance');
  } else if (today.precipChance >= 35) {
    score -= 18;
    reasons.push('possible showers');
  }

  if (today.windMax >= 28) {
    score -= 28;
    reasons.push('strong winds');
  } else if (today.windMax >= 20) {
    score -= 14;
    reasons.push('noticeable wind');
  }

  if (today.maxTemp >= 95 || current.temperature >= 95) {
    score -= 26;
    reasons.push('very hot temperatures');
  } else if (today.maxTemp >= 88 || current.temperature >= 88) {
    score -= 12;
    reasons.push('warm conditions');
  }

  if (today.minTemp <= 40) {
    score -= 8;
    reasons.push('chilly morning temps');
  }

  if (today.uvMax >= 9) {
    score -= 8;
    reasons.push('very high UV index');
  }

  if ([95, 96, 99].includes(today.weatherCode)) {
    score -= 35;
    reasons.push('thunderstorm risk');
  }

  if (nwsSignal?.scoreDelta) {
    score += nwsSignal.scoreDelta;
  }

  score = Math.max(0, Math.min(100, Math.round(score)));

  let verdict = 'Great day to ride';
  if (score < 80) {
    verdict = 'Decent day for a ride';
  }
  if (score < 55) {
    verdict = 'Not ideal for biking';
  }
  if (score < 35) {
    verdict = 'Skip biking today';
  }

  return {
    score,
    verdict,
    reasons,
    sourceSummary: nwsSignal?.summary || null,
  };
};

const fetchAvailableModels = async (apiKey) => {
  const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to list models: ${response.status} ${response.statusText}`);
  }
  const data = await response.json();
  return Array.isArray(data?.models) ? data.models : [];
};

// Serve static files from the public directory
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// API endpoint
app.get('/api/message', (req, res) => {
  res.json({ message: 'Hello from the server!' });
});

app.get('/api/models', async (req, res) => {
  if (!geminiApiKey) {
    return res.status(500).json({ error: 'Missing GEMINI_API_KEY.' });
  }

  try {
    const models = await fetchAvailableModels(geminiApiKey);
    const formatted = models.map((model) => ({
      name: model?.name,
      displayName: model?.displayName,
      supportedGenerationMethods: model?.supportedGenerationMethods || [],
    }));

    return res.json({ models: formatted });
  } catch (error) {
    console.error('Gemini list models error:', error);
    return res.status(500).json({
      error: 'Failed to list models.',
      message: error?.message || 'Unknown error',
    });
  }
});

app.get('/api/weather/san-jose', async (req, res) => {
  try {
    const weatherUrl = new URL('https://api.open-meteo.com/v1/forecast');
    weatherUrl.searchParams.set('latitude', String(SAN_JOSE.latitude));
    weatherUrl.searchParams.set('longitude', String(SAN_JOSE.longitude));
    weatherUrl.searchParams.set(
      'current',
      [
        'temperature_2m',
        'relative_humidity_2m',
        'apparent_temperature',
        'precipitation',
        'wind_speed_10m',
        'weather_code',
      ].join(',')
    );
    weatherUrl.searchParams.set(
      'daily',
      [
        'weather_code',
        'temperature_2m_max',
        'temperature_2m_min',
        'precipitation_probability_max',
        'wind_speed_10m_max',
        'uv_index_max',
      ].join(',')
    );
    weatherUrl.searchParams.set('temperature_unit', 'fahrenheit');
    weatherUrl.searchParams.set('wind_speed_unit', 'mph');
    weatherUrl.searchParams.set('precipitation_unit', 'inch');
    weatherUrl.searchParams.set('timezone', 'America/Los_Angeles');
    weatherUrl.searchParams.set('forecast_days', '6');

    const weatherResponse = await fetch(weatherUrl);
    if (!weatherResponse.ok) {
      throw new Error(`Open-Meteo request failed: ${weatherResponse.status}`);
    }

    const weatherData = await weatherResponse.json();
    const daily = weatherData?.daily;
    if (!weatherData?.current || !daily?.time || !Array.isArray(daily.time)) {
      throw new Error('Open-Meteo payload missing current or daily forecast data');
    }

    let nwsSignal = null;
    try {
      nwsSignal = await fetchNwsCyclingSignal();
    } catch (error) {
      console.warn('weather.gov signal unavailable', error?.message || error);
    }

    const forecast = daily.time.slice(0, 5).map((date, index) => ({
      date,
      weatherCode: daily.weather_code[index],
      summary: weatherCodeToLabel(daily.weather_code[index]),
      maxTemp: daily.temperature_2m_max[index],
      minTemp: daily.temperature_2m_min[index],
      precipChance: daily.precipitation_probability_max[index],
      windMax: daily.wind_speed_10m_max[index],
      uvMax: daily.uv_index_max[index],
    }));

    const today = forecast[0];
    const bicycling = getBicyclingRecommendation({
      current: {
        temperature: weatherData.current.temperature_2m,
      },
      today,
      nwsSignal,
    });

    return res.json({
      location: SAN_JOSE.name,
      updatedAt: weatherData.current.time,
      current: {
        temperature: weatherData.current.temperature_2m,
        feelsLike: weatherData.current.apparent_temperature,
        humidity: weatherData.current.relative_humidity_2m,
        precipitation: weatherData.current.precipitation,
        wind: weatherData.current.wind_speed_10m,
        weatherCode: weatherData.current.weather_code,
        summary: weatherCodeToLabel(weatherData.current.weather_code),
      },
      forecast,
      bicycling,
    });
  } catch (error) {
    console.error('Weather endpoint failed:', error);
    return res.status(500).json({
      error: 'Failed to retrieve weather data.',
      message: error?.message || 'Unknown error',
    });
  }
});

app.post('/api/chat', async (req, res) => {
  if (!geminiApiKey) {
    return res.status(500).json({ error: 'Missing GEMINI_API_KEY.' });
  }

  const message = typeof req.body?.message === 'string' ? req.body.message.trim() : '';
  if (!message) {
    return res.status(400).json({ error: 'Message is required.' });
  }

  const defaultMessages = [{ role: 'system', content: 'You are a helpful assistant.' }];

  try {
    const genAI = new GoogleGenerativeAI(geminiApiKey);
    const prompt = renderPrompt([...defaultMessages, { role: 'user', content: message }]);
    const configModel = normalizeModelName(geminiModel);
    const modelCandidates = [
      configModel,
      geminiModel,
      'gemini-2.5-flash',
      'gemini-2.0-flash',
      'gemini-1.5-flash',
      'gemini-1.5-pro',
      'gemini-1.0-pro',
      'gemini-pro',
    ];
    let lastError;

    for (const modelName of modelCandidates) {
      try {
        const model = genAI.getGenerativeModel({ model: modelName });
        const result = await model.generateContent(prompt);
        const reply = result?.response?.text?.() || '';

        return res.json({ reply, model: modelName });
      } catch (error) {
        lastError = error;
        const messageText = String(error?.message || '').toLowerCase();
        if (!messageText.includes('not found') && !messageText.includes('not supported')) {
          throw error;
        }
      }
    }

    try {
      const models = await fetchAvailableModels(geminiApiKey);
      const supported = models.filter((model) =>
        Array.isArray(model?.supportedGenerationMethods) &&
        model.supportedGenerationMethods.includes('generateContent')
      );
      const preferred = supported.find((model) =>
        /gemini-1\.5-flash|gemini-1\.5-pro|gemini-1\.0-pro|gemini-pro/i.test(model?.name || '')
      );
      const fallback = preferred || supported[0];

      if (fallback?.name) {
        const modelName = normalizeModelName(fallback.name);
        const model = genAI.getGenerativeModel({ model: modelName });
        const result = await model.generateContent(message);
        const reply = result?.response?.text?.() || '';

        return res.json({ reply, model: modelName });
      }
    } catch (error) {
      lastError = error;
    }

    throw lastError || new Error('No available Gemini model.');
  } catch (error) {
    console.error('Gemini chat error:', error);
    return res.status(500).json({
      error: 'Gemini request failed.',
      message: error?.message || 'Unknown error',
    });
  }
});

// Start the server
app.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
});
