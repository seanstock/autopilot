'use strict';

// Notifier: OS toast (Windows) + optional webhook. Best-effort, fire-and-
// forget: notify() never throws and never blocks the caller beyond
// spawning a child process / issuing a request. All failures are swallowed
// -- it is fine if a toast silently fails in CI or headless environments.
// Zero npm dependencies, Node built-ins only, CommonJS.

const { spawn } = require('child_process');
const http = require('http');
const https = require('https');
const { URL } = require('url');

// Escape a string for embedding inside a single-quoted PowerShell literal.
function psEscape(str) {
  return String(str).replace(/'/g, "''");
}

// Build the WinRT toast script. Kept pure ASCII (PowerShell 5.1 on Windows
// chokes on non-ASCII, e.g. the em-dash parse bug) and joined as one-liners
// via `;` so it can be passed through `-Command`.
function buildToastScript(title, body) {
  const t = psEscape(title);
  const b = psEscape(body);
  return [
    "[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null",
    "[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] > $null",
    "$template = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)",
    "$textNodes = $template.GetElementsByTagName('text')",
    `$textNodes.Item(0).AppendChild($template.CreateTextNode('${t}')) > $null`,
    `$textNodes.Item(1).AppendChild($template.CreateTextNode('${b}')) > $null`,
    "$toast = [Windows.UI.Notifications.ToastNotification]::new($template)",
    "[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('Autopilot').Show($toast)",
  ].join('; ');
}

function sendToast(title, body) {
  if (process.platform !== 'win32') return;
  try {
    const script = buildToastScript(title, body);
    const child = spawn('powershell', ['-NoProfile', '-Command', script], {
      windowsHide: true,
      stdio: 'ignore',
    });
    // Swallow everything: a failed toast is not a failed notify().
    child.on('error', () => {});
    child.unref();
  } catch (err) {
    // best effort, never throw
  }
}

function sendWebhook(webhookUrl, payload) {
  let parsed;
  try {
    parsed = new URL(webhookUrl);
  } catch (err) {
    return; // invalid URL, silently skip
  }
  const mod = parsed.protocol === 'http:' ? http : https;
  const data = JSON.stringify(payload);
  try {
    const req = mod.request(
      {
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === 'http:' ? 80 : 443),
        path: `${parsed.pathname}${parsed.search}`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(data),
        },
        timeout: 5000,
      },
      (res) => {
        res.resume(); // drain, don't care about the body
      }
    );
    req.on('error', () => {});
    req.on('timeout', () => {
      req.destroy();
    });
    req.write(data);
    req.end();
  } catch (err) {
    // best effort, never throw
  }
}

function notify(title, body, settings) {
  try {
    sendToast(title, body);
  } catch (err) {
    // best effort
  }
  try {
    if (settings && settings.webhook) {
      sendWebhook(settings.webhook, { title, body, t: new Date().toISOString() });
    }
  } catch (err) {
    // best effort
  }
}

module.exports = { notify };
