const token = process.env.ADMIN_API_TOKEN;
const response = await fetch('http://127.0.0.1:8080/api/admin/runtime/scheduler', {
  method: 'POST',
  headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
  body: JSON.stringify({ enabled: true })
});
const body = await response.json();
console.log(JSON.stringify({
  status: response.status,
  scheduler: body.scheduler,
  mode: body.mode,
  live_execution_authorized: body.live_execution_authorized
}, null, 2));