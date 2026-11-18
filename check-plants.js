const FIREBASE_URL = 'https://home-garden-dedec-default-rtdb.firebaseio.com';
const BOT_TOKEN = process.env.BOT_TOKEN;
const CHAT_ID = process.env.CHAT_ID;

// сколько дней осталось до события (положительное — ещё есть время, отрицательное — просрочено)
function daysUntil(dateStr, freqDays) {
  const dueAt = new Date(dateStr).getTime() + freqDays * 86400000;
  return (dueAt - Date.now()) / 86400000;
}

// сообщаем только в узком окне: от "завтра" до "вчера было пора" — не каждый день подряд
function describeIfRelevant(remainingDays, icon, action, name) {
  if (remainingDays > 1 || remainingDays <= -1) return null;
  if (remainingDays > 0) return `${icon} Завтра: ${action} «${name}»`;
  return `${icon} Сегодня: ${action} «${name}»`;
}

async function main() {
  const res = await fetch(`${FIREBASE_URL}/plants.json`);
  const plants = (await res.json()) || [];

  const messages = [];
  for (const p of plants) {
    if (p.notifyEnabled === false) continue;

    const water = describeIfRelevant(daysUntil(p.lastWatered, p.waterFreq), '💧', 'полить', p.name);
    if (water) messages.push(water);

    const fertilize = describeIfRelevant(daysUntil(p.lastFertilized, p.fertilizeFreq), '🌿', 'подкормить', p.name);
    if (fertilize) messages.push(fertilize);
  }

  if (messages.length === 0) {
    console.log('Ничего актуального, сообщение не отправляем.');
    return;
  }

  const text = `🌱 Home Garden\n\n${messages.join('\n')}`;

  await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: CHAT_ID, text }),
  });

  console.log('Отправлено:', text);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
