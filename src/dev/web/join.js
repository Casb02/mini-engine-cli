const $ = selector => document.querySelector(selector);

fetch('/__me/join/info')
  .then(response => response.json())
  .then(info => {
    $('#title').textContent = `Meedoen met ${info.title}`;
  })
  .catch(() => {});

$('#form').addEventListener('submit', async event => {
  event.preventDefault();
  const submit = $('#form button');
  submit.disabled = true;
  $('#notice').hidden = true;
  try {
    const response = await fetch('/__me/join', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: $('#name').value }) });
    const seat = await response.json();
    if (!response.ok) throw new Error(seat.error?.message ?? 'Dat lukte niet.');
    location.href = `${location.protocol}//${location.hostname}:${seat.port}${seat.path}#${seat.hash}`;
  } catch (error) {
    $('#notice').hidden = false;
    $('#notice').textContent = error.message;
    submit.disabled = false;
  }
});
