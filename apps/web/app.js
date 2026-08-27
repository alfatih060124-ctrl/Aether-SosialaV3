const status = document.querySelector('#system-status');
async function loadStatus() {
  if (!status) return;
  try {
    const response = await fetch('/api/health');
    if (!response.ok) throw new Error('health check failed');
    const data = await response.json();
    status.textContent = data.status === 'ok' ? 'SYSTEM HEALTHY' : 'SYSTEM DEGRADED';
  } catch {
    status.textContent = 'API NOT CONNECTED';
  }
}
loadStatus();
