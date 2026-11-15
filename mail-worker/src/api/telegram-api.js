import app from '../hono/hono';
import telegramService from '../service/telegram-service';

app.get('/telegram/getEmail/:token', async (c) => {
	const content = await telegramService.getEmailContent(c, c.req.param());
	c.header('Cache-Control', 'public, max-age=604800, immutable');
	return c.html(content);
});

app.get('/telegram/webhook', (c) => c.text('Telegram Webhook Active!'));

app.post('/telegram/webhook', async (c) => {
	return await telegramService.handleWebhook(c);
});
