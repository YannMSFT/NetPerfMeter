'use strict';

// Detects where the server is running (local network, public Internet, or Azure)
// and resolves a human-readable geographic location for testers. Dependency-free:
// uses the Azure Instance Metadata Service (IMDS) and App Service environment
// variables, with an optional manual override (SERVER_LOCATION). No third-party calls.

const os = require('os');
const http = require('http');
const net = require('net');

// Azure region code -> friendly name + approximate datacenter geography.
const AZURE_REGIONS = {
  eastus: { name: 'East US', city: 'Virginia', country: 'United States', cc: 'US', lat: 37.37, lon: -79.82 },
  eastus2: { name: 'East US 2', city: 'Virginia', country: 'United States', cc: 'US', lat: 36.67, lon: -78.39 },
  centralus: { name: 'Central US', city: 'Iowa', country: 'United States', cc: 'US', lat: 41.59, lon: -93.62 },
  northcentralus: { name: 'North Central US', city: 'Illinois', country: 'United States', cc: 'US', lat: 41.88, lon: -87.63 },
  southcentralus: { name: 'South Central US', city: 'Texas', country: 'United States', cc: 'US', lat: 29.42, lon: -98.49 },
  westus: { name: 'West US', city: 'California', country: 'United States', cc: 'US', lat: 37.78, lon: -122.42 },
  westus2: { name: 'West US 2', city: 'Washington', country: 'United States', cc: 'US', lat: 47.23, lon: -119.85 },
  westus3: { name: 'West US 3', city: 'Arizona', country: 'United States', cc: 'US', lat: 33.45, lon: -112.07 },
  canadacentral: { name: 'Canada Central', city: 'Toronto', country: 'Canada', cc: 'CA', lat: 43.65, lon: -79.38 },
  canadaeast: { name: 'Canada East', city: 'Quebec City', country: 'Canada', cc: 'CA', lat: 46.81, lon: -71.21 },
  brazilsouth: { name: 'Brazil South', city: 'São Paulo', country: 'Brazil', cc: 'BR', lat: -23.55, lon: -46.63 },
  northeurope: { name: 'North Europe', city: 'Dublin', country: 'Ireland', cc: 'IE', lat: 53.35, lon: -6.26 },
  westeurope: { name: 'West Europe', city: 'Amsterdam', country: 'Netherlands', cc: 'NL', lat: 52.37, lon: 4.90 },
  uksouth: { name: 'UK South', city: 'London', country: 'United Kingdom', cc: 'GB', lat: 51.51, lon: -0.13 },
  ukwest: { name: 'UK West', city: 'Cardiff', country: 'United Kingdom', cc: 'GB', lat: 51.48, lon: -3.18 },
  francecentral: { name: 'France Central', city: 'Paris', country: 'France', cc: 'FR', lat: 48.85, lon: 2.35 },
  francesouth: { name: 'France South', city: 'Marseille', country: 'France', cc: 'FR', lat: 43.30, lon: 5.37 },
  germanywestcentral: { name: 'Germany West Central', city: 'Frankfurt', country: 'Germany', cc: 'DE', lat: 50.11, lon: 8.68 },
  switzerlandnorth: { name: 'Switzerland North', city: 'Zürich', country: 'Switzerland', cc: 'CH', lat: 47.38, lon: 8.54 },
  norwayeast: { name: 'Norway East', city: 'Oslo', country: 'Norway', cc: 'NO', lat: 59.91, lon: 10.75 },
  swedencentral: { name: 'Sweden Central', city: 'Gävle', country: 'Sweden', cc: 'SE', lat: 60.67, lon: 17.14 },
  polandcentral: { name: 'Poland Central', city: 'Warsaw', country: 'Poland', cc: 'PL', lat: 52.23, lon: 21.01 },
  italynorth: { name: 'Italy North', city: 'Milan', country: 'Italy', cc: 'IT', lat: 45.46, lon: 9.19 },
  spaincentral: { name: 'Spain Central', city: 'Madrid', country: 'Spain', cc: 'ES', lat: 40.42, lon: -3.70 },
  uaenorth: { name: 'UAE North', city: 'Dubai', country: 'United Arab Emirates', cc: 'AE', lat: 25.20, lon: 55.27 },
  southafricanorth: { name: 'South Africa North', city: 'Johannesburg', country: 'South Africa', cc: 'ZA', lat: -26.20, lon: 28.05 },
  centralindia: { name: 'Central India', city: 'Pune', country: 'India', cc: 'IN', lat: 18.52, lon: 73.86 },
  southindia: { name: 'South India', city: 'Chennai', country: 'India', cc: 'IN', lat: 13.08, lon: 80.27 },
  westindia: { name: 'West India', city: 'Mumbai', country: 'India', cc: 'IN', lat: 19.08, lon: 72.88 },
  eastasia: { name: 'East Asia', city: 'Hong Kong', country: 'Hong Kong SAR', cc: 'HK', lat: 22.32, lon: 114.17 },
  southeastasia: { name: 'Southeast Asia', city: 'Singapore', country: 'Singapore', cc: 'SG', lat: 1.35, lon: 103.82 },
  japaneast: { name: 'Japan East', city: 'Tokyo', country: 'Japan', cc: 'JP', lat: 35.68, lon: 139.69 },
  japanwest: { name: 'Japan West', city: 'Osaka', country: 'Japan', cc: 'JP', lat: 34.69, lon: 135.50 },
  koreacentral: { name: 'Korea Central', city: 'Seoul', country: 'South Korea', cc: 'KR', lat: 37.57, lon: 126.98 },
  australiaeast: { name: 'Australia East', city: 'Sydney', country: 'Australia', cc: 'AU', lat: -33.87, lon: 151.21 },
  australiasoutheast: { name: 'Australia Southeast', city: 'Melbourne', country: 'Australia', cc: 'AU', lat: -37.81, lon: 144.96 },
};

// Normalizes a socket address: strips IPv6 zone suffix ("%eth0") and unwraps
// IPv4-mapped IPv6 ("::ffff:192.168.1.5" -> "192.168.1.5").
function normalizeAddress(address) {
  if (!address) return null;
  let value = String(address).trim();
  const pct = value.indexOf('%');
  if (pct !== -1) value = value.slice(0, pct);
  const mapped = value.toLowerCase().match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (mapped) value = mapped[1];
  return value;
}

function classifyIPv4(address) {
  const p = address.split('.').map(Number);
  const [a, b, c] = p;
  // Loopback / private / link-local / CGNAT all mean the client is local to the server.
  if (a === 127) return 'lan';
  if (a === 10) return 'lan';
  if (a === 172 && b >= 16 && b <= 31) return 'lan';
  if (a === 192 && b === 168) return 'lan';
  if (a === 169 && b === 254) return 'lan';
  if (a === 100 && b >= 64 && b <= 127) return 'lan';
  // Special-use / reserved / documentation ranges are not meaningful as "Internet".
  if (a === 0) return 'unknown';
  if (a >= 224) return 'unknown'; // multicast 224/4 + reserved 240/4
  if (a === 192 && b === 0 && c === 0) return 'unknown'; // 192.0.0/24 IETF protocol assignments
  if (a === 192 && b === 0 && c === 2) return 'unknown'; // 192.0.2/24 documentation
  if (a === 198 && b === 51 && c === 100) return 'unknown'; // 198.51.100/24 documentation
  if (a === 203 && b === 0 && c === 113) return 'unknown'; // 203.0.113/24 documentation
  if (a === 198 && (b === 18 || b === 19)) return 'unknown'; // 198.18/15 benchmarking
  return 'public';
}

function classifyIPv6(address) {
  const v = address.toLowerCase();
  if (v === '::1') return 'lan'; // loopback
  if (v === '::') return 'unknown'; // unspecified
  if (v.startsWith('fe80')) return 'lan'; // link-local
  if (v.startsWith('fc') || v.startsWith('fd')) return 'lan'; // unique local (fc00::/7)
  if (v.startsWith('ff')) return 'unknown'; // multicast
  if (v.startsWith('2001:db8')) return 'unknown'; // documentation
  return 'public'; // global unicast
}

// Classifies the address a client connected FROM into 'lan' | 'public' | 'unknown'.
// This is the reliable signal for "is the tester local to the server or remote over
// the Internet?" — far better than inspecting the server's own interfaces, since with
// IPv6 almost every home device has a globally-routable address of its own.
function classifyRemoteAddress(address) {
  const value = normalizeAddress(address);
  if (!value) return 'unknown';
  const family = net.isIP(value);
  if (family === 4) return classifyIPv4(value);
  if (family === 6) return classifyIPv6(value);
  return 'unknown';
}

function friendlyRegionFromCode(code) {
  const entry = AZURE_REGIONS[code];
  if (entry) {
    return { region: code, displayName: `Azure ${entry.name}`, city: entry.city, country: entry.country, countryCode: entry.cc, lat: entry.lat, lon: entry.lon };
  }
  return { region: code, displayName: `Azure (${code})`, city: null, country: null, countryCode: null, lat: null, lon: null };
}

function friendlyRegionFromName(name) {
  const target = String(name).trim().toLowerCase();
  const code = Object.keys(AZURE_REGIONS).find((key) => AZURE_REGIONS[key].name.toLowerCase() === target);
  if (code) {
    const entry = AZURE_REGIONS[code];
    return { region: name, displayName: `Azure ${entry.name}`, city: entry.city, country: entry.country, countryCode: entry.cc, lat: entry.lat, lon: entry.lon };
  }
  return { region: name, displayName: `Azure ${name}`, city: null, country: null, countryCode: null, lat: null, lon: null };
}

// Queries the Azure Instance Metadata Service. Resolves with metadata, or null
// when not running on an Azure VM/VMSS (the link-local address is unreachable).
function queryAzureImds(timeoutMs) {
  return new Promise((resolve) => {
    const req = http.request({
      host: '169.254.169.254',
      path: '/metadata/instance?api-version=2021-02-01',
      method: 'GET',
      headers: { Metadata: 'true' },
      timeout: timeoutMs,
    }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        resolve(null);
        return;
      }
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        data += chunk;
        if (data.length > 1_000_000) {
          req.destroy();
        }
      });
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch {
          resolve(null);
        }
      });
    });

    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(null));
    req.end();
  });
}

// Detects the cached, server-side facts once at startup: whether this host is in
// Azure (and which region) plus an optional manual label. LAN-vs-Internet exposure
// is NOT decided here — it depends on how each client connects (see buildEnvironmentView).
// Resolves: { isAzure, azureLocation|null, manualLabel|null, hostname, detectedAt }.
// Options allow dependency injection for tests (env, imds, hostname).
async function detectEnvironment(options = {}) {
  try {
    return await detectEnvironmentInner(options);
  } catch (err) {
    // detectEnvironment must never reject: callers (e.g. /api/info) rely on this.
    return {
      isAzure: false,
      azureLocation: null,
      manualLabel: safeManualLabel(options),
      hostname: safeHostname(options),
      detectedAt: Date.now(),
    };
  }
}

function safeHostname(options) {
  try {
    return options.hostname || os.hostname();
  } catch (err) {
    return '';
  }
}

function safeManualLabel(options) {
  try {
    const env = options.env || process.env;
    return (env.SERVER_LOCATION && String(env.SERVER_LOCATION).trim()) || null;
  } catch (err) {
    return null;
  }
}

async function detectEnvironmentInner(options = {}) {
  const env = options.env || process.env;
  const hostname = options.hostname || os.hostname();

  const isAppService = Boolean(env.WEBSITE_INSTANCE_ID || env.WEBSITE_SITE_NAME);
  const appServiceRegion = env.REGION_NAME;

  let imds = null;
  if (Object.prototype.hasOwnProperty.call(options, 'imds')) {
    imds = options.imds; // injected for tests (may be null)
  } else if (!isAppService) {
    const timeout = Number(env.IMDS_TIMEOUT_MS) > 0 ? Number(env.IMDS_TIMEOUT_MS) : 1000;
    imds = await queryAzureImds(timeout);
  }

  let isAzure = false;
  let azureLocation = null;

  if (isAppService && appServiceRegion) {
    isAzure = true;
    azureLocation = friendlyRegionFromName(appServiceRegion);
    azureLocation.source = 'azure-appservice';
  } else if (imds && imds.compute && imds.compute.location) {
    isAzure = true;
    azureLocation = friendlyRegionFromCode(imds.compute.location);
    azureLocation.source = 'azure-imds';
    azureLocation.zone = imds.compute.zone || null;
  } else if (isAppService) {
    // App Service without REGION_NAME is still Azure, just without a resolved region.
    isAzure = true;
    azureLocation = { region: null, displayName: 'Azure', city: null, country: null, countryCode: null, lat: null, lon: null, source: 'azure-appservice' };
  }

  const manualLabel = (env.SERVER_LOCATION && String(env.SERVER_LOCATION).trim()) || null;

  return { isAzure, azureLocation, manualLabel, hostname, detectedAt: Date.now() };
}

// Builds the per-request view returned by /api/info, combining the cached server facts
// with the address the client connected from. Exposure: 'azure' | 'lan' | 'public' | 'unknown'.
function buildEnvironmentView(cached, remoteAddress) {
  const c = cached || {};
  let exposure;
  let location;

  if (c.isAzure) {
    exposure = 'azure';
    location = c.azureLocation || { region: null, displayName: 'Azure', city: null, country: null, countryCode: null, lat: null, lon: null, source: 'azure' };
  } else {
    exposure = classifyRemoteAddress(remoteAddress);
    if (exposure === 'lan') {
      location = { region: null, displayName: 'Local network', city: null, country: null, countryCode: null, source: 'connection' };
    } else if (exposure === 'public') {
      location = { region: null, displayName: 'Internet host', city: null, country: null, countryCode: null, source: 'connection' };
    } else {
      location = { region: null, displayName: 'Unknown location', city: null, country: null, countryCode: null, source: 'connection' };
    }
  }

  // Optional manual override: replace the label, keep the detected exposure.
  if (c.manualLabel) {
    location = { region: null, displayName: c.manualLabel, city: null, country: null, countryCode: null, source: 'manual' };
  }

  return { exposure, location, hostname: c.hostname || '' };
}

module.exports = {
  detectEnvironment,
  buildEnvironmentView,
  classifyRemoteAddress,
  friendlyRegionFromCode,
  friendlyRegionFromName,
  AZURE_REGIONS,
};
