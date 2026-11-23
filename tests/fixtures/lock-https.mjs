// Sanctuary Computer (quickbooks-mcp-291): preload for start tests: makes https.request neither writable nor configurable, so the backstop can't install.
import https from 'node:https';

Object.defineProperty(https, 'request', { value: https.request, writable: false, configurable: false });
