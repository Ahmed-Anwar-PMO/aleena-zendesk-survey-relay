/***** ===== CONFIG: Zendesk & Sheet Columns ===== *****/

const SP = PropertiesService.getScriptProperties();
const ZD_SUBDOMAIN = SP.getProperty('ZD_SUBDOMAIN') || '';
const ZD_EMAIL     = SP.getProperty('ZD_EMAIL') || '';
const ZD_API_TOKEN = SP.getProperty('ZD_API_TOKEN') || '';
const COL_CSAT_RATE   = 3; // C: CSAT rate (عدّلها لو مختلفة)
const COL_NPS_RATE    = 4; // D: NPS rate
const COL_COMMENT     = 6; // E: customer comment
const VERY_LOW_CSAT_THRESHOLD = 2; // عدّلها لو عندك مقياس مختلف


// Optional: explicitly set your own name/email if needed
const AHMED_NAME  = 'Ahmed Anwar';                        // adjust if your display name is different
const AHMED_EMAIL = SP.getProperty('AHMED_EMAIL') || ZD_EMAIL;

// Form Responses sheet columns (1-based)
const COL_TICKET_ID   = 7; // H: ticket number (or something containing it)
const COL_AGENT_NAME  = 8; // I: where we write CSAT agent name


/***** ===== HELPER: Normalize ticket ID ===== *****/
/**
 * Accepts raw cell value and tries to extract a numeric ticket id.
 * - If it's a number → returns int
 * - If it's a string → returns first integer inside it (e.g. "Ticket #220162")
 * - Else → returns null
 */
function normalizeTicketId_(raw) {
  if (raw === null || raw === '') return null;

  // Already a number
  if (typeof raw === 'number') {
    return Math.floor(raw);
  }

  // String: extract first number
  if (typeof raw === 'string') {
    const match = raw.match(/\d+/);
    if (match) {
      return parseInt(match[0], 10);
    }
    return null;
  }

  return null;
}


/***** ===== TRIGGER: On Form Submit (new responses) ===== *****/

/**
 * Installable trigger:
 * - From Apps Script: Triggers → Add Trigger
 * - Function: onFormSubmit
 * - Event source: From spreadsheet
 * - Event type: On form submit
 */
function onFormSubmit(e) {
  try {
    const sheet = e.range.getSheet();
    const row   = e.range.getRow();

    const rawTicket = sheet.getRange(row, COL_TICKET_ID).getValue();
    const ticketId  = normalizeTicketId_(rawTicket);

    if (!ticketId) {
      Logger.log(`Row ${row}: invalid ticket id in column H ("${rawTicket}") – skipping.`);
      return;
    }

    const agentName = getTicketAgentForCSAT_(ticketId);
    if (!agentName) {
      Logger.log(`Row ${row}: ticket ${ticketId} → no agent found for CSAT`);
      // نكمّل برضه نرسل النتيجة لو حاب حتى لو ما عرفنا الوكيل
      // return;  // تقدر تشيل الـ return لو تبغى النوت تنرسل على أي حال
    }

    // نكتب اسم الوكيل في العمود المخصص
    sheet.getRange(row, COL_AGENT_NAME).setValue(agentName);
    Logger.log(`Row ${row}: ticket ${ticketId} → CSAT agent "${agentName}"`);

    // 🆕 اقرأ قيم CSAT / NPS / Comment من الصف
    const csatRate = sheet.getRange(row, COL_CSAT_RATE).getValue();
    const npsRate  = sheet.getRange(row, COL_NPS_RATE).getValue();
    const comment  = sheet.getRange(row, COL_COMMENT).getValue();

    // 🆕 أرسل نوت داخلية للتيكت وحطه على hold
    postCSATInternalNoteToZendesk_(ticketId, csatRate, npsRate, comment);

  } catch (err) {
    Logger.log('Error in onFormSubmit: ' + err);
  }
}



/***** ===== BACKFILL: Existing rows in Form Responses ===== *****/

/**
 * One-time or occasional backfill for existing responses in the sheet.
 * - Loops from row 2 to last row
 * - If ticket ID in H is valid AND agent name in I is empty:
 *   → compute & fill CSAT agent
 */
function backfillAgentsForExistingRows() {
  const ss    = SpreadsheetApp.getActive();
  const sheet = ss.getActiveSheet(); // or ss.getSheetByName('Form Responses 1')

  const lastRow = sheet.getLastRow();
  if (lastRow < 2) {
    Logger.log('No data rows to process.');
    return;
  }

  for (let rowIndex = 2; rowIndex <= lastRow; rowIndex++) {
    const rawTicket     = sheet.getRange(rowIndex, COL_TICKET_ID).getValue();
    const ticketId      = normalizeTicketId_(rawTicket);
    const existingAgent = sheet.getRange(rowIndex, COL_AGENT_NAME).getValue();

    if (!ticketId) {
      Logger.log(`Row ${rowIndex}: invalid ticket id in column H ("${rawTicket}") – skipping.`);
      continue;
    }
    if (existingAgent) {
      continue; // already filled, skip
    }

    try {
      const agentName = getTicketAgentForCSAT_(ticketId);
      if (agentName) {
        sheet.getRange(rowIndex, COL_AGENT_NAME).setValue(agentName);
        Logger.log(`Row ${rowIndex}: ticket ${ticketId} → ${agentName}`);
      } else {
        Logger.log(`Row ${rowIndex}: ticket ${ticketId} → no agent found (after all fallbacks)`);
      }
    } catch (err) {
      Logger.log(`Row ${rowIndex}: ticket ${ticketId} error: ${err}`);
    }

    // avoid hammering Zendesk API
    Utilities.sleep(300); // 0.3s per request
  }

  Logger.log('Backfill complete.');
}


/***** ===== CORE DECISION: Which agent gets the CSAT ===== *****/

/**
 * Decide the "CSAT owner" for a ticket in this order:
 * 1) Agent/admin with most PUBLIC replies
 *    - BUT if that agent is Ahmed AND any other agent collaborated (any comment),
 *      then pick the collaborator instead.
 * 2) Agent who last changed status → solved/closed
 * 3) Current assignee
 * If none found → returns empty string
 */
function getTicketAgentForCSAT_(ticketId) {
  // 1) Most replying agent (public replies only, with Ahmed override logic)
  const topReplier = getTicketTopAgentByReplies_(ticketId);
  if (topReplier) {
    Logger.log(`Ticket ${ticketId}: CSAT agent (top replier logic) = "${topReplier}"`);
    return topReplier;
  }

  // 2) Fallback: solver via audits (status → solved/closed)
  const solver = getTicketSolverName_(ticketId);
  if (solver) {
    Logger.log(`Ticket ${ticketId}: no public replies; fallback to solver "${solver}"`);
    return solver;
  }

  // 3) Last resort: assignee on the ticket
  const assignee = getTicketAssigneeName_(ticketId);
  if (assignee) {
    Logger.log(`Ticket ${ticketId}: no public replies & no solver; fallback to assignee "${assignee}"`);
    return assignee;
  }

  Logger.log(`Ticket ${ticketId}: no replies, no solver, no assignee → leaving blank`);
  return '';
}


/***** ===== HELPER 1: Most replying agent (PUBLIC replies only, Ahmed override) ===== *****/

/**
 * Returns name of the agent/admin with most PUBLIC replies on a ticket.
 * - Counts only comments where `public === true`
 * - Ignores end-users (role === 'end-user')
 *
 * EXTRA RULE:
 * - If the top public replier is Ahmed (AHMED_NAME/AHMED_EMAIL)
 *   AND at least one other agent/admin left ANY comment (public or internal),
 *   then return that other collaborator instead (the one with most activity).
 * - If Ahmed is the ONLY agent with comments → return Ahmed.
 */
function getTicketTopAgentByReplies_(ticketId) {
  if (!ZD_SUBDOMAIN || !ZD_EMAIL || !ZD_API_TOKEN) {
    throw new Error('Zendesk config missing in Script Properties');
  }

  const authHeader = 'Basic ' +
    Utilities.base64Encode(ZD_EMAIL + '/token:' + ZD_API_TOKEN);

  const url = `https://${ZD_SUBDOMAIN}.zendesk.com/api/v2/tickets/${ticketId}/comments.json?include=users`;
  const options = {
    method: 'get',
    headers: {
      'Authorization': authHeader,
      'Content-Type': 'application/json'
    },
    muteHttpExceptions: true
  };

  const resp = UrlFetchApp.fetch(url, options);
  const code = resp.getResponseCode();
  if (code !== 200) {
    Logger.log(`Zendesk comments error for ticket ${ticketId}: HTTP ${code} – ${resp.getContentText()}`);
    return '';
  }

  const data     = JSON.parse(resp.getContentText());
  const comments = data.comments || [];
  const users    = data.users || [];

  const userMap = {};
  users.forEach(u => userMap[u.id] = u);

  // Count public replies
  const publicCounts = {};
  // Count ALL agent/admin comments (public + internal) to detect collaborators
  const totalCounts  = {};

  comments.forEach(c => {
    const authorId = c.author_id;
    const user     = userMap[authorId];
    if (!user) return;

    // Ignore requester/end-user – only agents/admins/etc
    if (user.role === 'end-user') return;

    // Count total comments (public + internal) for collaboration detection
    totalCounts[authorId] = (totalCounts[authorId] || 0) + 1;

    // Only public replies for main "top replier" logic
    if (c.public) {
      publicCounts[authorId] = (publicCounts[authorId] || 0) + 1;
    }
  });

  const publicCandidates = Object.keys(publicCounts).map(idStr => {
    const id   = Number(idStr);
    const user = userMap[id] || {};
    return {
      id,
      publicCount: publicCounts[id],
      totalCount: totalCounts[id] || publicCounts[id] || 0,
      name: user.name || '',
      email: user.email || ''
    };
  });

  if (publicCandidates.length === 0) {
    Logger.log(`No agent PUBLIC replies found for ticket ${ticketId}`);
    return '';
  }

  // Helper: decide if a candidate is "Ahmed"
  function isAhmed(c) {
    const byEmail = c.email && AHMED_EMAIL &&
      c.email.toLowerCase() === AHMED_EMAIL.toLowerCase();
    const byName  = c.name && AHMED_NAME &&
      c.name.trim().toLowerCase() === AHMED_NAME.trim().toLowerCase();
    return byEmail || byName;
  }

  // Sort by public replies desc, then total activity desc
  publicCandidates.sort((a, b) => {
    if (b.publicCount !== a.publicCount) {
      return b.publicCount - a.publicCount;
    }
    return b.totalCount - a.totalCount;
  });

  const top = publicCandidates[0];

  // If top replier is NOT Ahmed → return as is
  if (!isAhmed(top)) {
    Logger.log(
      `Ticket ${ticketId}: top public replier = "${top.name}" with ${top.publicCount} public replies (total ${top.totalCount}).`
    );
    return top.name || '';
  }

  // Top is Ahmed → look for another collaborator (any comment)
  const collaborators = Object.keys(totalCounts).map(idStr => {
    const id   = Number(idStr);
    const user = userMap[id] || {};
    return {
      id,
      totalCount: totalCounts[id],
      publicCount: publicCounts[id] || 0,
      name: user.name || '',
      email: user.email || ''
    };
  }).filter(c => !isAhmed(c)); // exclude Ahmed himself

  if (collaborators.length === 0) {
    // Ahmed is literally the only agent who commented
    Logger.log(
      `Ticket ${ticketId}: only Ahmed has agent comments (${top.publicCount} public of ${top.totalCount} total) → keeping Ahmed.`
    );
    return top.name || '';
  }

  // Choose collaborator with most total comments, then most public, as CSAT owner
  collaborators.sort((a, b) => {
    if (b.totalCount !== a.totalCount) {
      return b.totalCount - a.totalCount;
    }
    return b.publicCount - a.publicCount;
  });

  const collaborator = collaborators[0];
  Logger.log(
    `Ticket ${ticketId}: top public replier is Ahmed (${top.publicCount} public), ` +
    `but collaborator "${collaborator.name}" has total ${collaborator.totalCount} comments (public ${collaborator.publicCount}) → using collaborator.`
  );
  return collaborator.name || '';
}


/***** ===== HELPER 2: Solver (status → solved/closed) from audits ===== *****/

/**
 * Returns the name of the user who last set status to solved/closed.
 * - Scans audits for Change events on field "status"
 * - Accepts value "solved" OR "closed"
 */
function getTicketSolverName_(ticketId) {
  if (!ZD_SUBDOMAIN || !ZD_EMAIL || !ZD_API_TOKEN) {
    throw new Error('Zendesk config missing in Script Properties');
  }

  const authHeader = 'Basic ' +
    Utilities.base64Encode(ZD_EMAIL + '/token:' + ZD_API_TOKEN);

  const url = `https://${ZD_SUBDOMAIN}.zendesk.com/api/v2/tickets/${ticketId}/audits.json?include=users`;
  const options = {
    method: 'get',
    headers: {
      'Authorization': authHeader,
      'Content-Type': 'application/json'
    },
    muteHttpExceptions: true
  };

  const resp = UrlFetchApp.fetch(url, options);
  const code = resp.getResponseCode();
  if (code !== 200) {
    Logger.log(`Zendesk audits error for ticket ${ticketId}: HTTP ${code} – ${resp.getContentText()}`);
    return '';
  }

  const data   = JSON.parse(resp.getContentText());
  const audits = data.audits || [];
  const users  = data.users || [];

  const userMap = {};
  users.forEach(u => userMap[u.id] = u);

  let solverId = null;

  // Look for last status → solved OR closed
  audits.forEach(audit => {
    const events = audit.events || [];
    const statusChange = events.find(ev =>
      ev.type === 'Change' &&
      ev.field === 'status' &&
      (ev.value === 'solved' || ev.value === 'closed')
    );
    if (statusChange && audit.author_id) {
      solverId = audit.author_id;
    }
  });

  if (!solverId) {
    Logger.log(`No solver found for ticket ${ticketId}`);
    return '';
  }

  if (userMap[solverId]) {
    return userMap[solverId].name || '';
  }

  // Fallback: fetch user directly
  const userUrl  = `https://${ZD_SUBDOMAIN}.zendesk.com/api/v2/users/${solverId}.json`;
  const userResp = UrlFetchApp.fetch(userUrl, options);
  if (userResp.getResponseCode() !== 200) {
    Logger.log(`Zendesk user error for id ${solverId}: HTTP ${userResp.getResponseCode()}`);
    return '';
  }
  const userData = JSON.parse(userResp.getContentText());
  return (userData.user && userData.user.name) ? userData.user.name : '';
}


/***** ===== HELPER 3: Assignee name from ticket ===== *****/

/**
 * Returns the current assignee's name for the ticket.
 * - Uses tickets/{id}.json to get assignee_id
 * - Then fetches user object
 */
function getTicketAssigneeName_(ticketId) {
  if (!ZD_SUBDOMAIN || !ZD_EMAIL || !ZD_API_TOKEN) {
    throw new Error('Zendesk config missing in Script Properties');
  }

  const authHeader = 'Basic ' +
    Utilities.base64Encode(ZD_EMAIL + '/token:' + ZD_API_TOKEN);

  const ticketUrl = `https://${ZD_SUBDOMAIN}.zendesk.com/api/v2/tickets/${ticketId}.json`;
  const options = {
    method: 'get',
    headers: {
      'Authorization': authHeader,
      'Content-Type': 'application/json'
    },
    muteHttpExceptions: true
  };

  const resp = UrlFetchApp.fetch(ticketUrl, options);
  const code = resp.getResponseCode();
  if (code !== 200) {
    Logger.log(`Zendesk ticket error for ${ticketId}: HTTP ${code} – ${resp.getContentText()}`);
    return '';
  }

  const data   = JSON.parse(resp.getContentText());
  const ticket = data.ticket;
  if (!ticket || !ticket.assignee_id) {
    Logger.log(`Ticket ${ticketId} has no assignee_id`);
    return '';
  }

  const assigneeId = ticket.assignee_id;

  const userUrl  = `https://${ZD_SUBDOMAIN}.zendesk.com/api/v2/users/${assigneeId}.json`;
  const userResp = UrlFetchApp.fetch(userUrl, options);
  if (userResp.getResponseCode() !== 200) {
    Logger.log(`Zendesk user error for assignee ${assigneeId}: HTTP ${userResp.getResponseCode()}`);
    return '';
  }

  const userData = JSON.parse(userResp.getContentText());
  const name = (userData.user && userData.user.name) ? userData.user.name : '';
  if (!name) {
    Logger.log(`Assignee ${assigneeId} has no name for ticket ${ticketId}`);
  }
  return name;
}

/**
 * تضيف نوت داخلية في التذكرة وتحوّل حالتها إلى hold
 * بالمحتوى العربي الجميل 👇
 */
function postCSATInternalNoteToZendesk_(ticketId, csatRate, npsRate, comment) {
  if (!ZD_SUBDOMAIN || !ZD_EMAIL || !ZD_API_TOKEN) {
    throw new Error('Zendesk config missing in Script Properties');
  }

  const authHeader = 'Basic ' +
    Utilities.base64Encode(ZD_EMAIL + '/token:' + ZD_API_TOKEN);

  const url = `https://${ZD_SUBDOMAIN}.zendesk.com/api/v2/tickets/${ticketId}.json`;

  // تحويل CSAT لرقم + نتحقق من وجود تعليق فعلي
  const csatNumber  = Number(csatRate);
  const hasComment  = comment && String(comment).trim() !== '';
  const isVeryLow   = hasComment && !isNaN(csatNumber) && csatNumber <= VERY_LOW_CSAT_THRESHOLD;

  // نكتب ملاحظة مختلفة حسب حالة التذكرة
  let noteBody;

  if (isVeryLow) {
    noteBody =
`📊 نتائج استبيان العميل وصلت:

مستوى رضا العميل (من الى 5): ${csatRate}
مستوى ترشيح العميل (من 1 الى 10): ${npsRate}

💬 تعليق العميل:
"${comment}"

🟡 تم تحويل هذه التذكرة إلى وضع الانتظار (On-hold)
بسبب انخفاض التقييم ووجود تعليق من العميل.
الرجاء مراجعة ملاحظات العميل والتواصل معه لمعالجة السبب ثم إغلاق التذكرة بعد المتابعة.`;
  } else {
    noteBody =
`📊 نتائج استبيان العميل وصلت:

مستوى رضا العميل (من الى 5): ${csatRate}
مستوى ترشيح العميل (من 1 الى 10): ${npsRate}

💬 تعليق العميل:
"${comment}"

ℹ️ هذه الملاحظة لإطلاعك على تقييم العميل فقط.
لا يلزم اتخاذ إجراء إلا إذا رأيت أن متابعة العميل مناسبة.`;
  }

  // نجهّز الـ ticket data (comment دايمًا، status + tags حسب الشرط)
  const ticketData = {
    comment: {
      public: false,
      body: noteBody
    }
  };

  // لو التقييم منخفض جداً + فيه تعليق → نحط التذكرة hold ونضيف التاج csat_very_low
  if (isVeryLow) {
    ticketData.status = 'hold';

    // نحافظ على التاجات القديمة + نضيف csat_very_low
    let tags = [];
    try {
      const getOptions = {
        method: 'get',
        headers: {
          'Authorization': authHeader,
          'Content-Type': 'application/json'
        },
        muteHttpExceptions: true
      };
      const getResp = UrlFetchApp.fetch(url, getOptions);
      if (getResp.getResponseCode() === 200) {
        const ticketDataResp = JSON.parse(getResp.getContentText());
        if (ticketDataResp.ticket && Array.isArray(ticketDataResp.ticket.tags)) {
          tags = ticketDataResp.ticket.tags.slice();
        }
      } else {
        Logger.log(`Could not fetch existing tags for ticket ${ticketId}: HTTP ${getResp.getResponseCode()} – ${getResp.getContentText()}`);
      }
    } catch (e) {
      Logger.log(`Error while fetching existing tags for ticket ${ticketId}: ${e}`);
    }

    if (tags.indexOf('csat_very_low') === -1) {
      tags.push('csat_very_low');
    }
    ticketData.tags = tags;
  }

  const payload = {
    ticket: ticketData
  };

  const options = {
    method: 'put',
    muteHttpExceptions: true,
    contentType: 'application/json',
    payload: JSON.stringify(payload),
    headers: {
      'Authorization': authHeader
    }
  };

  const resp = UrlFetchApp.fetch(url, options);
  const code = resp.getResponseCode();
  const body = resp.getContentText();

  if (code !== 200) {
    Logger.log(`Zendesk CSAT note error for ticket ${ticketId}: HTTP ${code} – ${body}`);
  } else {
    Logger.log(
      `Zendesk CSAT note added for ticket ${ticketId}. isVeryLow=${isVeryLow}, statusChanged=${isVeryLow ? 'hold' : 'unchanged'}`
    );
  }
}
