const FIREBASE_URL = 'https://home-garden-dedec-default-rtdb.firebaseio.com';
const APP_URL = 'https://flower-care-app-drab.vercel.app/';
const BOT_TOKEN = process.env.BOT_TOKEN;
const CHAT_IDS = [process.env.CHAT_ID, process.env.CHAT_ID_2].filter(Boolean);

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

  for (const chatId of CHAT_IDS) {
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        reply_markup: {
          inline_keyboard: [[{ text: '🌱 Открыть Home Garden', url: APP_URL }]],
        },
      }),
    });
  }

  console.log('Отправлено получателям:', CHAT_IDS.length, text);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
