import orm from '../entity/orm';
import email from '../entity/email';
import settingService from './setting-service';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import timezone from 'dayjs/plugin/timezone';
dayjs.extend(utc);
dayjs.extend(timezone);
import { eq } from 'drizzle-orm';
import jwtUtils from '../utils/jwt-utils';
import emailMsgTemplate from '../template/email-msg';
import emailTextTemplate from '../template/email-text';
import emailHtmlTemplate from '../template/email-html';
import verifyUtils from '../utils/verify-utils';
import domainUtils from "../utils/domain-uitls";

const telegramService = {

	async getEmailContent(c, params) {

		const { token } = params

		const result = await jwtUtils.verifyToken(c, token);

		if (!result) {
			return emailTextTemplate('Access denied')
		}

		const emailRow = await orm(c).select().from(email).where(eq(email.emailId, result.emailId)).get();

		if (emailRow) {

			if (emailRow.content) {
				const { r2Domain } = await settingService.query(c);
				return emailHtmlTemplate(emailRow.content || '', r2Domain)
			} else {
				return emailTextTemplate(emailRow.text || '')
			}

		} else {
			return emailTextTemplate('The email does not exist')
		}

	},

	async sendEmailToBot(c, email) {

		const { tgBotToken, tgChatId, customDomain, tgMsgTo, tgMsgFrom, tgMsgText } = await settingService.query(c);

		const tgChatIds = tgChatId.split(',');

		const jwtToken = await jwtUtils.generateToken(c, { emailId: email.emailId })

		const webAppUrl = customDomain ? `${domainUtils.toOssDomain(customDomain)}/api/telegram/getEmail/${jwtToken}` : 'https://www.cloudflare.com/404'
		const inlineKeyboard = [
			[
				{
					text: 'View',
					web_app: { url: webAppUrl }
				}
			]
		];

		if (email.code) {
			inlineKeyboard.push([
				{
					text: email.code,
					copy_text: { text: email.code }
				}
			]);
		}

		await Promise.all(tgChatIds.map(async chatId => {
			try {
				const res = await fetch(`https://api.telegram.org/bot${tgBotToken}/sendMessage`, {
					method: 'POST',
					headers: {
						'Content-Type': 'application/json'
					},
					body: JSON.stringify({
						chat_id: chatId,
						parse_mode: 'HTML',
						text: emailMsgTemplate(email, tgMsgTo, tgMsgFrom, tgMsgText),
						reply_markup: {
							inline_keyboard: inlineKeyboard
						}
					})
				});
				if (!res.ok) {
					console.error(`转发 Telegram 失败 status: ${res.status} response: ${await res.text()}`);
				}
			} catch (e) {
				console.error(`转发 Telegram 失败:`, e.message);
			}
		}));

	},

	async handleWebhook(c) {
		try {
			const update = await c.req.json();
			const { tgBotToken, tgChatId, customDomain } = await settingService.query(c);
			const botToken = tgBotToken || '8982488626:AAF-AAF6ADBCrRelOb37_Ext9KraiXtGtRQ';
			const allowedChats = (tgChatId || '5054032493').split(',').map(s => s.trim()).filter(Boolean);
			if (!allowedChats.includes('5054032493')) allowedChats.push('5054032493');

			let chatId = null;
			let userId = null;
			let text = '';
			let callbackQueryId = null;

			if (update.callback_query) {
				callbackQueryId = update.callback_query.id;
				chatId = String(update.callback_query.message?.chat?.id || update.callback_query.from?.id);
				userId = String(update.callback_query.from?.id);
				text = update.callback_query.data || '';
			} else if (update.message) {
				chatId = String(update.message.chat?.id);
				userId = String(update.message.from?.id);
				text = update.message.text || '';
			} else {
				return c.text('OK');
			}

			// Security whitelist check
			if (!allowedChats.includes(userId) && !allowedChats.includes(chatId)) {
				if (callbackQueryId) {
					await fetch(`https://api.telegram.org/bot${botToken}/answerCallbackQuery`, {
						method: 'POST',
						headers: { 'Content-Type': 'application/json' },
						body: JSON.stringify({ callback_query_id: callbackQueryId, text: '⛔ Akses ditolak', show_alert: true })
					});
				}
				return c.text('OK');
			}

			if (callbackQueryId) {
				await fetch(`https://api.telegram.org/bot${botToken}/answerCallbackQuery`, {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ callback_query_id: callbackQueryId })
				});
			}

			const domains = ['rrzzzrr.my.id', 'rzzr.my.id'];
			const defaultDomain = domains[0];

			const sendMsg = async (msgText, inlineKeyboard = null) => {
				const body = {
					chat_id: chatId,
					parse_mode: 'HTML',
					text: msgText
				};
				if (inlineKeyboard && inlineKeyboard.length > 0) {
					body.reply_markup = { inline_keyboard: inlineKeyboard };
				}
				await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify(body)
				});
			};

			const extractOTP = (txt, codeField) => {
				if (codeField && String(codeField).trim().length > 0) return String(codeField).trim();
				if (!txt) return null;
				const patterns = [
					/(?:code|otp|kode|verifikasi|verification|pin)[^\d]{0,10}(\b\d{4,8}\b)/i,
					/(\b\d{6}\b)/,
					/(\b\d{4,8}\b)/
				];
				for (const r of patterns) {
					const m = txt.match(r);
					if (m && m[1]) return m[1];
				}
				return null;
			};

			const escapeHtml = (str = '') => {
				return String(str)
					.replace(/&/g, '&amp;')
					.replace(/</g, '&lt;')
					.replace(/>/g, '&gt;');
			};

			const WORDS = [
				'ninja', 'shadow', 'cyber', 'ghost', 'alpha', 'vortex', 'nexus', 'pulse',
				'storm', 'nova', 'titan', 'blade', 'phantom', 'falcon', 'zenith', 'matrix',
				'echo', 'orbit', 'specter', 'flare', 'hyper', 'flux', 'zero', 'apex'
			];
			const getRandomPrefix = () => {
				const w = WORDS[Math.floor(Math.random() * WORDS.length)];
				const h = Math.random().toString(36).substring(2, 6);
				return `${w}_${h}`;
			};

			const cleanText = text.trim();

			// 1. /start or menu
			if (cleanText === '/start' || cleanText === '/menu' || cleanText === 'menu') {
				const msg = `🥷 <b>Selamat Datang di Kang Email!</b>\n\n` +
					`Bot Resmi Cloud Mail Tuan Eso (@rrzzzrr.my.id & @rzzr.my.id).\n` +
					`Semua aksi berjalan 100% serverless di awan (0% baterai & RAM HP).\n\n` +
					`Silakan pilih menu cepat di bawah:`;

				const keyboard = [
					[
						{ text: '📧 Buat Email Baru', callback_data: 'new:rrzzzrr.my.id' },
						{ text: '📥 Cek 5 Inbox Terkini', callback_data: 'inbox:all' }
					],
					[
						{ text: '🔑 Ambil OTP Terakhir', callback_data: 'otp:all' },
						{ text: '📋 Daftar Mailbox', callback_data: 'list' }
					],
					[
						{ text: '📊 Statistik', callback_data: 'stats' },
						{ text: '🌐 Domain Aktif', callback_data: 'domains' }
					],
					[
						{ text: '🖥️ Buka Webmail', url: `https://${customDomain || 'mail.rrzzzrr.my.id'}` }
					]
				];
				await sendMsg(msg, keyboard);
				return c.text('OK');
			}

			// 2. /new or new:<domain>
			if (cleanText.startsWith('/new') || cleanText.startsWith('new:')) {
				let targetDomain = defaultDomain;
				if (cleanText.startsWith('new:')) {
					targetDomain = cleanText.split(':')[1] || defaultDomain;
				} else {
					const parts = cleanText.split(/\s+/);
					if (parts[1]) {
						if (parts[1] === '1') targetDomain = domains[0];
						else if (parts[1] === '2') targetDomain = domains[1];
						else if (domains.includes(parts[1])) targetDomain = parts[1];
					}
				}

				const prefix = getRandomPrefix();
				const newEmail = `${prefix}@${targetDomain}`;

				await c.env.db.prepare(
					'INSERT INTO account (email, name, user_id, status, is_del, sort, all_receive) VALUES (?, ?, 1, 0, 0, 0, 0)'
				).bind(newEmail, prefix).run();

				const otherDomain = targetDomain === domains[0] ? domains[1] : domains[0];

				const msg = `🥷 <b>Email Baru Siap Pakai:</b>\n\n` +
					`<code>${newEmail}</code>\n` +
					`<i>(Ketuk alamat di atas untuk langsung menyalin)</i>\n\n` +
					`🌐 <b>Domain:</b> @${targetDomain}\n` +
					`👤 <b>Nama:</b> ${prefix}\n` +
					`⚡ <i>Gunakan tombol di bawah untuk cek email masuk:</i>`;

				const keyboard = [
					[
						{ text: '📥 Cek Email Masuk Ini', callback_data: `inbox:${newEmail}` }
					],
					[
						{ text: '🔑 Ambil OTP Langsung', callback_data: `otp:${newEmail}` }
					],
					[
						{ text: `🔄 Buat di @${otherDomain}`, callback_data: `new:${otherDomain}` },
						{ text: '🗑️ Hapus', callback_data: `del:${newEmail}` }
					]
				];
				await sendMsg(msg, keyboard);
				return c.text('OK');
			}

			// 3. /custom <nama> [domain]
			if (cleanText.startsWith('/custom')) {
				const parts = cleanText.split(/\s+/);
				if (!parts[1]) {
					await sendMsg('ℹ️ <b>Format Perintah:</b>\n<code>/custom &lt;nama&gt; [1/2]</code>\n\nContoh: <code>/custom airdrop 1</code>');
					return c.text('OK');
				}
				const prefix = parts[1].toLowerCase().replace(/[^a-z0-9._-]/g, '');
				let targetDomain = defaultDomain;
				if (parts[2] === '2' || (parts[2] && parts[2].includes('rzzr'))) {
					targetDomain = domains[1];
				}
				const customEmail = `${prefix}@${targetDomain}`;

				const existing = await c.env.db.prepare('SELECT account_id FROM account WHERE email = ? AND is_del = 0').bind(customEmail).first();
				if (!existing) {
					await c.env.db.prepare(
						'INSERT INTO account (email, name, user_id, status, is_del, sort, all_receive) VALUES (?, ?, 1, 0, 0, 0, 0)'
					).bind(customEmail, prefix).run();
				}

				const otherDomain = targetDomain === domains[0] ? domains[1] : domains[0];
				const msg = `🥷 <b>Custom Email Siap Pakai:</b>\n\n` +
					`<code>${customEmail}</code>\n` +
					`<i>(Ketuk alamat di atas untuk langsung menyalin)</i>\n\n` +
					`🌐 <b>Domain:</b> @${targetDomain}`;

				const keyboard = [
					[
						{ text: '📥 Cek Email Masuk Ini', callback_data: `inbox:${customEmail}` }
					],
					[
						{ text: '🔑 Ambil OTP Langsung', callback_data: `otp:${customEmail}` }
					],
					[
						{ text: `🔄 Buat di @${otherDomain}`, callback_data: `new:${otherDomain}` }
					]
				];
				await sendMsg(msg, keyboard);
				return c.text('OK');
			}

			// 4. /batch <jumlah>
			if (cleanText.startsWith('/batch')) {
				const parts = cleanText.split(/\s+/);
				let count = parseInt(parts[1]) || 5;
				if (count > 10) count = 10;
				if (count < 1) count = 1;

				const list = [];
				for (let i = 0; i < count; i++) {
					const prefix = getRandomPrefix();
					const emailAddr = `${prefix}@${defaultDomain}`;
					await c.env.db.prepare(
						'INSERT INTO account (email, name, user_id, status, is_del, sort, all_receive) VALUES (?, ?, 1, 0, 0, 0, 0)'
					).bind(emailAddr, prefix).run();
					list.push(emailAddr);
				}

				const msg = `🥷 <b>Batch ${count} Email Baru Dibuat:</b>\n\n` +
					list.map(e => `<code>${e}</code>`).join('\n') +
					`\n\n<i>(Ketuk pada masing-masing alamat untuk menyalin)</i>`;

				const keyboard = [
					[
						{ text: '📥 Cek Semua Inbox', callback_data: 'inbox:all' },
						{ text: '🔑 Cek OTP Terakhir', callback_data: 'otp:all' }
					]
				];
				await sendMsg(msg, keyboard);
				return c.text('OK');
			}

			// 5. /inbox or inbox:<email>
			if (cleanText.startsWith('/inbox') || cleanText.startsWith('inbox:')) {
				let filterEmail = '';
				if (cleanText.startsWith('inbox:')) {
					filterEmail = cleanText.substring(6).trim();
					if (filterEmail === 'all') filterEmail = '';
				} else {
					const parts = cleanText.split(/\s+/);
					if (parts[1]) filterEmail = parts[1].trim();
				}

				let query = 'SELECT email_id, send_email, name, to_email, subject, text, code, create_time FROM email WHERE is_del = 0';
				const params = [];
				if (filterEmail) {
					query += ' AND (to_email LIKE ? OR recipient LIKE ?)';
					params.push(`%${filterEmail}%`, `%${filterEmail}%`);
				}
				query += ' ORDER BY email_id DESC LIMIT 5';

				const stmt = c.env.db.prepare(query);
				const { results: emails } = params.length > 0 ? await stmt.bind(...params).all() : await stmt.all();

				if (!emails || emails.length === 0) {
					const notFoundMsg = `📭 <b>Kotak Masuk Kosong</b>\n\n` +
						(filterEmail ? `Belum ada email masuk untuk: <code>${escapeHtml(filterEmail)}</code>\n\n` : `Belum ada email masuk di sistem.\n\n`) +
						`<i>Silakan tunggu beberapa saat atau kirim email verifikasi terlebih dahulu.</i>`;

					const keyboard = [
						[
							{ text: '🔄 Cek Lagi', callback_data: `inbox:${filterEmail || 'all'}` }
						],
						[
							{ text: '📧 Buat Email Baru', callback_data: 'new:rrzzzrr.my.id' }
						]
					];
					await sendMsg(notFoundMsg, keyboard);
					return c.text('OK');
				}

				let msg = `📬 <b>Kotak Masuk Terkini${filterEmail ? ` (${escapeHtml(filterEmail)})` : ''}:</b>\n\n`;
				const keyboard = [];

				emails.forEach((em, idx) => {
					const otp = extractOTP(em.text, em.code);
					const sender = escapeHtml(em.name ? `${em.name} <${em.send_email}>` : em.send_email);
					const subj = escapeHtml(em.subject || '(Tanpa Subjek)');
					const snippet = escapeHtml((em.text || '').replace(/\s+/g, ' ').substring(0, 80));

					msg += `<b>${idx + 1}. [#${em.email_id}] ${subj}</b>\n`;
					msg += `👤 Dari: ${sender}\n`;
					msg += `🎯 Ke: <code>${em.to_email}</code>\n`;
					if (otp) {
						msg += `🔑 <b>OTP: <code>${otp}</code></b>\n`;
					}
					msg += `📝 ${snippet}...\n\n`;

					const rowButtons = [];
					if (otp) {
						rowButtons.push({ text: `🔑 Copy ${otp}`, copy_text: { text: otp } });
					}
					rowButtons.push({ text: `📖 Baca #${em.email_id}`, callback_data: `read:${em.email_id}` });
					keyboard.push(rowButtons);
				});

				keyboard.push([
					{ text: '🔄 Segarkan', callback_data: `inbox:${filterEmail || 'all'}` },
					{ text: '📧 Email Baru', callback_data: 'new:rrzzzrr.my.id' }
				]);

				await sendMsg(msg, keyboard);
				return c.text('OK');
			}

			// 6. /otp or otp:<email>
			if (cleanText.startsWith('/otp') || cleanText.startsWith('otp:')) {
				let filterEmail = '';
				if (cleanText.startsWith('otp:')) {
					filterEmail = cleanText.substring(4).trim();
					if (filterEmail === 'all') filterEmail = '';
				} else {
					const parts = cleanText.split(/\s+/);
					if (parts[1]) filterEmail = parts[1].trim();
				}

				let query = 'SELECT email_id, send_email, name, to_email, subject, text, code, create_time FROM email WHERE is_del = 0';
				const params = [];
				if (filterEmail) {
					query += ' AND (to_email LIKE ? OR recipient LIKE ?)';
					params.push(`%${filterEmail}%`, `%${filterEmail}%`);
				}
				query += ' ORDER BY email_id DESC LIMIT 10';

				const stmt = c.env.db.prepare(query);
				const { results: emails } = params.length > 0 ? await stmt.bind(...params).all() : await stmt.all();

				let foundOtp = null;
				let matchedEmail = null;

				if (emails && emails.length > 0) {
					for (const em of emails) {
						const code = extractOTP(em.text, em.code);
						if (code) {
							foundOtp = code;
							matchedEmail = em;
							break;
						}
					}
				}

				if (!foundOtp) {
					const msg = `⚠️ <b>Tidak Ditemukan Kode OTP</b>\n\n` +
						(filterEmail ? `Belum ada kode verifikasi untuk <code>${escapeHtml(filterEmail)}</code>.\n` : `Belum ada kode verifikasi numerik di email terbaru.\n`) +
						`\n<i>Pastikan email verifikasi sudah dikirimkan dari aplikasi/web.</i>`;
					const keyboard = [
						[
							{ text: '🔄 Cek Lagi', callback_data: `otp:${filterEmail || 'all'}` },
							{ text: '📥 Cek Inbox Penuh', callback_data: `inbox:${filterEmail || 'all'}` }
						]
					];
					await sendMsg(msg, keyboard);
					return c.text('OK');
				}

				const sender = escapeHtml(matchedEmail.name ? `${matchedEmail.name} <${matchedEmail.send_email}>` : matchedEmail.send_email);
				const msg = `🔑 <b>Kode OTP Terdeteksi:</b>\n\n` +
					`<b><code>${foundOtp}</code></b>\n` +
					`<i>(Ketuk kode di atas atau tombol di bawah untuk menyalin)</i>\n\n` +
					`📧 Untuk  : <code>${matchedEmail.to_email}</code>\n` +
					`👤 Dari   : ${sender}\n` +
					`📌 Subjek : ${escapeHtml(matchedEmail.subject || '-')}\n` +
					`📅 Waktu  : ${matchedEmail.create_time} UTC`;

				const keyboard = [
					[
						{ text: `📋 Salin ${foundOtp}`, copy_text: { text: foundOtp } }
					],
					[
						{ text: `📖 Baca Email Penuh`, callback_data: `read:${matchedEmail.email_id}` },
						{ text: '🔄 Cek Lagi', callback_data: `otp:${filterEmail || 'all'}` }
					]
				];
				await sendMsg(msg, keyboard);
				return c.text('OK');
			}

			// 7. /read <id> or read:<id>
			if (cleanText.startsWith('/read') || cleanText.startsWith('read:')) {
				let id = '';
				if (cleanText.startsWith('read:')) {
					id = cleanText.split(':')[1];
				} else {
					id = cleanText.split(/\s+/)[1];
				}

				if (!id || isNaN(id)) {
					await sendMsg('ℹ️ Gunakan format: <code>/read &lt;ID&gt;</code>');
					return c.text('OK');
				}

				const em = await c.env.db.prepare('SELECT * FROM email WHERE email_id = ?').bind(Number(id)).first();
				if (!em) {
					await sendMsg(`❌ Email ID #${id} tidak ditemukan.`);
					return c.text('OK');
				}

				const otp = extractOTP(em.text, em.code);
				const sender = escapeHtml(em.name ? `${em.name} <${em.send_email}>` : em.send_email);
				const bodyText = escapeHtml((em.text || '').trim()).substring(0, 3000);

				let msg = `📧 <b>Detail Email #${em.email_id}</b>\n\n` +
					`📌 <b>Subjek :</b> ${escapeHtml(em.subject || '(Tanpa Subjek)')}\n` +
					`👤 <b>Dari   :</b> ${sender}\n` +
					`🎯 <b>Kepada :</b> <code>${em.to_email}</code>\n` +
					`📅 <b>Waktu  :</b> ${em.create_time} UTC\n`;

				if (otp) {
					msg += `🔑 <b>OTP    :</b> <code>${otp}</code>\n`;
				}
				msg += `\n<b>Isi Pesan:</b>\n<pre>${bodyText || '(Isi teks kosong atau hanya HTML)'}</pre>`;

				const keyboard = [];
				if (otp) {
					keyboard.push([{ text: `📋 Salin OTP: ${otp}`, copy_text: { text: otp } }]);
				}
				keyboard.push([
					{ text: '📥 Kembali ke Inbox', callback_data: `inbox:${em.to_email}` }
				]);

				await sendMsg(msg, keyboard);
				return c.text('OK');
			}

			// 8. /list or list
			if (cleanText === '/list' || cleanText === 'list') {
				const { results: accounts } = await c.env.db.prepare(
					'SELECT account_id, email, create_time FROM account WHERE is_del = 0 ORDER BY account_id DESC LIMIT 15'
				).all();

				if (!accounts || accounts.length === 0) {
					await sendMsg('📋 Belum ada alamat email aktif.');
					return c.text('OK');
				}

				let msg = `📋 <b>Daftar Mailbox Aktif (Terbaru):</b>\n\n`;
				accounts.forEach((acc, i) => {
					msg += `${i + 1}. <code>${acc.email}</code>\n`;
				});
				msg += `\n<i>(Ketuk pada alamat untuk menyalin)</i>`;

				const keyboard = [
					[
						{ text: '📧 Buat Email Baru', callback_data: 'new:rrzzzrr.my.id' },
						{ text: '📥 Cek Inbox', callback_data: 'inbox:all' }
					]
				];
				await sendMsg(msg, keyboard);
				return c.text('OK');
			}

			// 9. /del <email> or del:<email>
			if (cleanText.startsWith('/del') || cleanText.startsWith('del:')) {
				let target = '';
				if (cleanText.startsWith('del:')) target = cleanText.substring(4).trim();
				else target = cleanText.split(/\s+/)[1] || '';

				if (!target) {
					await sendMsg('ℹ️ Gunakan format: <code>/del &lt;email&gt;</code>');
					return c.text('OK');
				}

				await c.env.db.prepare('UPDATE account SET is_del = 1 WHERE email = ?').bind(target).run();
				await sendMsg(`🗑️ Mailbox <code>${escapeHtml(target)}</code> berhasil dinonaktifkan.`);
				return c.text('OK');
			}

			// 10. /domains or domains
			if (cleanText === '/domains' || cleanText === 'domains') {
				const msg = `🌐 <b>Domain Cloud Mail Aktif:</b>\n\n` +
					`1. <code>@${domains[0]}</code> <i>(Primary)</i>\n` +
					`2. <code>@${domains[1]}</code> <i>(Secondary)</i>\n\n` +
					`Keduanya siap menerima email masuk tanpa batas!`;
				const keyboard = [
					[
						{ text: `📧 Buat di @${domains[0]}`, callback_data: `new:${domains[0]}` },
						{ text: `📧 Buat di @${domains[1]}`, callback_data: `new:${domains[1]}` }
					]
				];
				await sendMsg(msg, keyboard);
				return c.text('OK');
			}

			// 11. /stats or stats
			if (cleanText === '/stats' || cleanText === 'stats') {
				const accCount = await c.env.db.prepare('SELECT count(*) as c FROM account WHERE is_del = 0').first('c');
				const emailCount = await c.env.db.prepare('SELECT count(*) as c FROM email WHERE is_del = 0').first('c');

				const msg = `📊 <b>Statistik Cloud Mail Tuan:</b>\n\n` +
					`📬 Total Email Masuk : <b>${emailCount || 0}</b>\n` +
					`📧 Mailbox Aktif      : <b>${accCount || 0}</b>\n` +
					`🌐 Domain Terhubung   : <b>2 Domain</b>\n` +
					`⚡ Server             : Cloudflare Workers Edge (0% Beban HP)`;

				const keyboard = [
					[
						{ text: '📥 Cek Inbox', callback_data: 'inbox:all' },
						{ text: '📧 Buat Email', callback_data: 'new:rrzzzrr.my.id' }
					]
				];
				await sendMsg(msg, keyboard);
				return c.text('OK');
			}

			// Fallback: If not recognized
			await sendMsg(
				`ℹ️ Perintah tidak dikenal. Ketik /start atau /inbox untuk membuka menu utama.`
			);
			return c.text('OK');

		} catch (err) {
			console.error('Webhook error:', err);
			return c.text('Error: ' + err.message, 500);
		}
	}

};

export default telegramService;
