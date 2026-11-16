import PostalMime from 'postal-mime';
import emailService from '../service/email-service';
import accountService from '../service/account-service';
import settingService from '../service/setting-service';
import attService from '../service/att-service';
import constant from '../const/constant';
import fileUtils from '../utils/file-utils';
import { emailConst, isDel, settingConst } from '../const/entity-const';
import emailUtils from '../utils/email-utils';
import roleService from '../service/role-service';
import userService from '../service/user-service';
import telegramService from '../service/telegram-service';
import aiService from '../service/ai-service';
import webhookService from '../service/webhook-service';

export async function email(message, env, ctx) {

	try {

		const {
			receive,
			tgChatId,
			tgBotStatus,
			forwardStatus,
			forwardEmail,
			webhookStatus,
			webhookUrl,
			webhookRetry,
			webhookSecret,
			ruleEmail,
			ruleType,
			r2Domain,
			noRecipient,
			blackSubject,
			blackContent,
			blackFrom,
			aiCode,
			aiCodeFilter
		} = await settingService.query({ env });

		if (receive === settingConst.receive.CLOSE) {
			message.setReject('Service suspended');
			return;
		}

		const reader = message.raw.getReader();
		let content = '';

		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			content += new TextDecoder().decode(value);
		}

		const email = await PostalMime.parse(content);


		const blockFlag = checkBlock(blackSubject, blackContent, blackFrom, email);

		if (blockFlag) {
			message.setReject('Message rejected');
			return;
		}

		let account = await accountService.selectByEmailIncludeDel({ env: env }, message.to);

		if (!account) {
			const baseEmail = emailUtils.getBaseEmail(message.to);
			if (baseEmail && baseEmail !== message.to) {
				account = await accountService.selectByEmailIncludeDel({ env: env }, baseEmail);
			}
		}

		if (!account && noRecipient === settingConst.noRecipient.CLOSE) {
			message.setReject('Recipient not found');
			return;
		}

		let userRow = {}

		if (account) {
			 userRow = await userService.selectByIdIncludeDel({ env: env }, account.userId);
		}

		if (account && userRow.email !== env.admin) {

			let { banEmail, availDomain } = await roleService.selectByUserId({ env: env }, account.userId);

			if (!roleService.hasAvailDomainPerm(availDomain, message.to)) {
				message.setReject('The recipient is not authorized to use this domain.');
				return;
			}

			if(roleService.isBanEmail(banEmail, email.from.address)) {
				message.setReject('The recipient is disabled from receiving emails.');
				return;
			}

		}


		if (!email.to) {
			email.to = [{ address: message.to, name: emailUtils.getName(message.to)}]
		}

		const toName = email.to.find(item => item.address === message.to)?.name || '';

		// 1. Coba ekstraksi via Regex cepat (0ms, 0 Neurons)
		let code = extractRegexOTP(email.text, email.html);

		// 2. Fallback AI: Jika Regex lokal gagal, panggil Workers AI Llama 3.1
		if (!code) {
			try {
				code = await aiService.extractCode({ env }, email, { aiCode, aiCodeFilter });
			} catch (e) {
				console.error('AI Fallback Error: ', e);
				code = '';
			}
		}

		const fromAddress = email.from?.address || '';

		const params = {
			toEmail: message.to,
			toName: toName,
			sendEmail: fromAddress,
			name: email.from?.name || emailUtils.getName(fromAddress),
			senderEmail: message.from || '',
			subject: email.subject,
			code,
			content: email.html,
			text: email.text,
			cc: email.cc ? JSON.stringify(email.cc) : '[]',
			bcc: email.bcc ? JSON.stringify(email.bcc) : '[]',
			recipient: JSON.stringify(email.to),
			inReplyTo: email.inReplyTo,
			relation: email.references,
			messageId: email.messageId,
			userId: account ? account.userId : 0,
			accountId: account ? account.accountId : 0,
			isDel: isDel.DELETE,
			status: emailConst.status.SAVING
		};

		const attachments = [];
		const cidAttachments = [];

		for (let item of email.attachments) {
			let attachment = { ...item };
			attachment.key = constant.ATTACHMENT_PREFIX + await fileUtils.getBuffHash(attachment.content) + fileUtils.getExtFileName(item.filename);
			attachment.size = item.content.length ?? item.content.byteLength;
			attachments.push(attachment);
			if (attachment.contentId) {
				cidAttachments.push(attachment);
			}
		}

		let emailRow = await emailService.receive({ env }, params, cidAttachments, r2Domain);

		attachments.forEach(attachment => {
			attachment.emailId = emailRow.emailId;
			attachment.userId = emailRow.userId;
			attachment.accountId = emailRow.accountId;
		});

		try {
			if (attachments.length > 0) {
				await attService.addAtt({ env }, attachments);
			}
		} catch (e) {
			console.error(e);
		}

		emailRow = await emailService.completeReceive({ env }, account ? emailConst.status.RECEIVE : emailConst.status.NOONE, emailRow.emailId);


		if (ruleType === settingConst.ruleType.RULE) {

			const emails = ruleEmail.split(',');

			if (!emails.includes(message.to)) {
				return;
			}

		}

		// 转发到TG (Skip jika akun berstatus silent / mode hening untuk script otomasi)
		const isSilent = account && (account.status === 2 || (account.name && account.name.includes('[silent]')));

		if (tgBotStatus === settingConst.tgBotStatus.OPEN && tgChatId && !isSilent) {
			await telegramService.sendEmailToBot({ env }, emailRow);
		}

		//转发到其他邮箱
		if (forwardStatus === settingConst.forwardStatus.OPEN && forwardEmail) {

			const emails = forwardEmail.split(',');

			await Promise.all(emails.map(async email => {

				try {
					await message.forward(email);
				} catch (e) {
					console.error(`转发邮箱 ${email} 失败：`, e);
				}

			}));

		}

		//转发到 Webhook
		if (webhookStatus === settingConst.webhookStatus.OPEN && webhookUrl) {
			await webhookService.sendEmail({ env }, emailRow, webhookUrl, webhookRetry, webhookSecret);
		}

	} catch (e) {
		console.error('邮件接收异常: ', e);
		throw e
	}
}

function checkBlock(blackSubjectStr, blackContentStr, blackFromStr, email) {

	const blackFromList = blackFromStr ? blackFromStr.split(',') : []
	const blackContentList = blackContentStr ? blackContentStr.split(',') : []
	const blackSubjectList = blackSubjectStr ? blackSubjectStr.split(',') : []

	for (const blackSubject of blackSubjectList) {
		if (email.subject?.includes(blackSubject)) {
			return true
		}
	}

	for (const blackContent of blackContentList) {
		if (email.html?.includes(blackContent) || email.text?.includes(blackContent)) {
			return true
		}
	}

	for (const blackFrom of blackFromList) {
		if (email.from.address === blackFrom || emailUtils.getDomain(email.from.address) === blackFrom) {
			return true
		}
	}

	return false

}

const IGNORED_OTP_WORDS = new Set([
	'VERIFY', 'CODE', 'EMAIL', 'PLEASE', 'ENTER', 'CLICK', 'BELOW', 'VALID', 'UNTIL',
	'RESET', 'LOGIN', 'SECURE', 'ACCESS', 'YOUR', 'THIS', 'FROM', 'DEAR', 'USER',
	'THANKS', 'TEAM', 'SUPPORT', 'SERVICE', 'ACCOUNT', 'NUMBER', 'CONFIRM'
]);

function extractRegexOTP(text, html) {
	const content = (text || '') + ' ' + (html || '');
	if (!content.trim()) return '';

	// 1. Hyphenated pattern with keyword: e.g. code is 123-456 or ABC-DEF
	const hyphenMatch = content.match(/(?:code|otp|kode|verifikasi|verification|pin)[^\d\n]{0,25}\b([a-zA-Z0-9]{3,4})-([a-zA-Z0-9]{3,4})\b/i);
	if (hyphenMatch) return `${hyphenMatch[1]}${hyphenMatch[2]}`.toUpperCase();

	// 2. Keyword with 4-8 alphanumeric code
	const keywordMatch = content.match(/(?:code|otp|kode|verifikasi|verification|pin|password)[^\d\n]{0,25}\b([a-zA-Z0-9]{4,8})\b/i);
	if (keywordMatch) {
		const candidate = keywordMatch[1].trim();
		if (!IGNORED_OTP_WORDS.has(candidate.toUpperCase())) {
			if (/\d/.test(candidate) || candidate === candidate.toUpperCase()) {
				return candidate;
			}
		}
	}

	// 3. Standalone 6-digit number
	const sixDigit = content.match(/\b(\d{6})\b/);
	if (sixDigit) return sixDigit[1];

	// 4. Standalone 4 to 8 digit number
	const numMatch = content.match(/\b(\d{4,8})\b/);
	if (numMatch) return numMatch[1];

	// 5. Standalone uppercase alphanumeric token with at least 1 digit
	const alphaNum = content.match(/\b(?=[a-zA-Z0-9]*\d)(?=[a-zA-Z0-9]*[a-zA-Z])[a-zA-Z0-9]{4,8}\b/);
	if (alphaNum) return alphaNum[0].toUpperCase();

	return '';
}
