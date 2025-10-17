// server/runner.mjs — refactored for label-first detection, clarity, and robust logging

import { chromium } from 'playwright';
import { promises as fs } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const CONFIG_PATH = resolve(__dirname, '..', 'config', 'user.json');
const OUT_DIR = resolve(__dirname, '..', 'output');
const CSV_PATH = resolve(OUT_DIR, 'applied.csv');

const log = (...a) => console.log('[easyapply]', ...a);

/* ------------------------------- boot & logging ------------------------------ */

async function ensureOutFiles() {
  await fs.mkdir(OUT_DIR, { recursive: true }).catch(() => { });
  try { await fs.access(CSV_PATH); }
  catch {
    await fs.writeFile(
      CSV_PATH,
      'version,timestamp_start,timestamp_end,status,company,job_title,source,url,resume_used,notes,job_id\n',
      'utf8'
    );
  }
}

const csvEsc = s => {
  const v = String(s ?? '');
  return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
};

async function appendCsv(row) {
  const line = [
    1,
    row.tsStart,
    row.tsEnd,
    row.status,
    row.company || '',
    row.title || '',
    row.source || '',
    row.url,
    row.resume || '',
    row.notes || '',
    row.jobId || ''
  ].map(csvEsc).join(',') + '\n';
  await fs.appendFile(CSV_PATH, line, 'utf8');
}

/* ---------------------------------- config ---------------------------------- */

async function loadUser() {
  const raw = await fs.readFile(CONFIG_PATH, 'utf8');
  const u = JSON.parse(raw);

  for (const k of ['firstName', 'lastName', 'email', 'resumePath']) {
    if (!u[k]) throw new Error(`Missing "${k}" in ${CONFIG_PATH}`);
  }
  u.resumePath = resolve(__dirname, '..', u.resumePath);
  return u;
}

/* ------------------------------- meta extraction ----------------------------- */

async function extractMeta(page) {
  try {
    const data = await page.evaluate(() => {
      const get = (sel) =>
        document.querySelector(sel)?.content ||
        document.querySelector(sel)?.innerText ||
        null;

      const ogTitle = get('meta[property="og:title"]');
      const twTitle = get('meta[name="twitter:title"]');
      const h1 = document.querySelector('h1')?.innerText || null;
      let title = (ogTitle || twTitle || h1 || document.title || '').trim().slice(0, 160);

      const siteName = document.querySelector('meta[property="og:site_name"]')?.content || null;

      // JSON-LD JobPosting → company
      let company = null;
      for (const s of Array.from(document.querySelectorAll('script[type="application/ld+json"]'))) {
        try {
          const j = JSON.parse(s.textContent || '{}');
          const arr = Array.isArray(j) ? j : [j];
          for (const obj of arr) {
            if (obj['@type'] === 'JobPosting' && obj.hiringOrganization?.name) {
              company = obj.hiringOrganization.name;
              break;
            }
          }
          if (company) break;
        } catch { }
      }
      return { title, siteName, company };
    });

    const host = new URL(page.url()).hostname;
    let source = 'Other';
    if (host.includes('greenhouse.io')) source = 'Greenhouse';
    else if (host.includes('lever.co')) source = 'Lever';
    else if (host.includes('myworkdayjobs')) source = 'Workday';
    else if (host.includes('personio') || host.includes('join.com')) source = 'Personio';
    else if (host.includes('smartrecruiters')) source = 'SmartRecruiters';
    else if (host.includes('linkedin.com')) source = 'LinkedIn';

    const company = data.company || data.siteName || host.replace(/^www\./, '');
    const title = data.title || '';
    return { company, title, source };
  } catch {
    return { company: '', title: '', source: 'Other' };
  }
}

/* --------------------------------- helpers ---------------------------------- */
/** Utilities use getByLabel/getByRole first (most stable), then light heuristics **/

async function fillTextByLabel(page, labels, value, fieldName) {
  if (!value) { log(`fill: skip ${fieldName} – empty value`); return false; }
  for (const name of labels) {
    try {
      const input = page.getByLabel(name, { exact: false });
      if (await input.count()) {
        await input.first().fill(value);
        log(`fill: ok   ${fieldName} via label "${name}"`);
        return true;
      }
    } catch { }
  }
  // fallback: role=textbox with accessible name
  for (const name of labels) {
    try {
      const tb = page.getByRole('textbox', { name, exact: false });
      if (await tb.count()) {
        await tb.first().fill(value);
        log(`fill: ok   ${fieldName} via role name "${name}"`);
        return true;
      }
    } catch { }
  }
  log(`fill: miss ${fieldName}`);
  return false;
}

async function clickRadioByLabel(page, labels, optionText, fieldName) {
  // Example: Gender → "Female"
  if (!optionText) return false;
  // try grouped by field label first
  for (const groupLabel of labels) {
    try {
      const group = page.getByRole('group', { name: groupLabel, exact: false });
      if (await group.count()) {
        const radio = group.getByRole('radio', { name: optionText, exact: false }).first();
        if (await radio.count()) {
          await radio.check().catch(async () => await radio.click());
          log(`radio: ok   ${fieldName}="${optionText}" via group "${groupLabel}"`);
          return true;
        }
      }
    } catch { }
  }
  // global fallback
  try {
    const radio = page.getByRole('radio', { name: optionText, exact: false }).first();
    if (await radio.count()) {
      await radio.check().catch(async () => await radio.click());
      log(`radio: ok   ${fieldName}="${optionText}" (global)`);
      return true;
    }
  } catch { }
  log(`radio: miss ${fieldName}="${optionText}"`);
  return false;
}

async function selectByLabel(page, labels, value, fieldName) {
  if (!value) { log(`select: skip ${fieldName} – empty value`); return false; }
  for (const name of labels) {
    try {
      const sel = page.getByLabel(name, { exact: false });
      if (await sel.count()) {
        // try select element
        const el = sel.first();
        try {
          await el.selectOption({ label: value }).catch(async () => {
            await el.selectOption({ value }).catch(async () => {
              await el.fill(value);
            });
          });
          log(`select: ok   ${fieldName}="${value}" via label "${name}"`);
          return true;
        } catch { }
      }
    } catch { }
  }
  // role=combobox fallback
  for (const name of labels) {
    try {
      const combo = page.getByRole('combobox', { name, exact: false });
      if (await combo.count()) {
        const el = combo.first();
        await el.fill(value).catch(async () => await el.pressSequentially(value));
        log(`select: ok   ${fieldName} via combobox "${name}" (typed)`);
        return true;
      }
    } catch { }
  }
  log(`select: miss ${fieldName}`);
  return false;
}

async function setFileByLabel(page, labels, filePath, fieldName) {
  if (!filePath) return false;
  for (const name of labels) {
    try {
      const inp = page.getByLabel(name, { exact: false });
      if (await inp.count()) {
        const el = inp.first();
        await el.setInputFiles(filePath);
        log(`upload: ok   ${fieldName} via label "${name}"`);
        return true;
      }
    } catch { }
  }
  // fallback plain file input
  try {
    const files = page.locator('input[type=file]');
    if (await files.count()) {
      await files.first().setInputFiles(filePath);
      log(`upload: ok   ${fieldName} via generic file input`);
      return true;
    }
  } catch { }
  log(`upload: miss ${fieldName}`);
  return false;
}

async function findFirstVisibleSelector(page, selectors, label) {
  for (const sel of selectors) {
    const loc = page.locator(sel).first();
    try {
      if (await loc.count()) {
        const visible = await loc.isVisible().catch(() => true);
        if (visible) {
          log(`detect: found ${label} via ${sel}`);
          return sel;
        }
      }
    } catch { }
  }
  log(`detect: no ${label} found`);
  return null;
}

async function fillGenericField(page, fieldType, value, fieldName) {
  if (!value) { log(`generic: skip ${fieldName} – empty value`); return false; }

  const selectors = GENERIC_SELECTORS[fieldType] || [];
  for (const sel of selectors) {
    try {
      const loc = page.locator(sel).first();
      if (await loc.count()) {
        const visible = await loc.isVisible().catch(() => true);
        if (visible) {
          await loc.fill(value);
          log(`generic: ok   ${fieldName} via ${sel}`);
          return true;
        }
      }
    } catch { }
  }

  // Try alternative approach: look for fields near text that contains the field name
  // This now works for any field type, not just linkedin/github
  try {
    const fieldText = fieldType.toLowerCase();
    const nearbyInput = page.locator(`text=${fieldText} >> .. >> input`).first();
    if (await nearbyInput.count()) {
      const visible = await nearbyInput.isVisible().catch(() => true);
      if (visible) {
        await nearbyInput.fill(value);
        log(`generic: ok   ${fieldName} via nearby text "${fieldText}"`);
        return true;
      }
    }
  } catch { }

  log(`generic: miss ${fieldName}`);
  return false;
}

async function showHoldBanner(page, message = 'Review & finish any missing fields, then submit. When done, CLOSE this tab to continue.') {
  await page.evaluate((msg) => {
    if (document.getElementById('__ea_hold_banner')) return;
    const wrap = document.createElement('div');
    wrap.id = '__ea_hold_banner';
    wrap.style.position = 'fixed';
    wrap.style.right = '16px';
    wrap.style.bottom = '16px';
    wrap.style.zIndex = '2147483647';
    wrap.style.background = 'rgba(17,24,39,0.96)';
    wrap.style.color = '#fff';
    wrap.style.padding = '10px 12px';
    wrap.style.borderRadius = '10px';
    wrap.style.font = '13px/1.3 system-ui, -apple-system, Segoe UI, Roboto, sans-serif';
    wrap.style.boxShadow = '0 6px 24px rgba(0,0,0,0.3)';
    wrap.textContent = msg;
    document.body.appendChild(wrap);
  }, message);
}

async function waitForFormStability(page, maxWaitTime = 5000) {
  let previousFieldCount = 0;
  let stableCount = 0;
  const startTime = Date.now();

  while (Date.now() - startTime < maxWaitTime) {
    const currentFieldCount = await page.evaluate(() => {
      return document.querySelectorAll('input, select, textarea').length;
    });

    if (currentFieldCount === previousFieldCount) {
      stableCount++;
      if (stableCount >= 3) { // Stable for 3 checks
        log(`form: stable with ${currentFieldCount} fields after ${Date.now() - startTime}ms`);
        return true;
      }
    } else {
      stableCount = 0;
      log(`form: field count changed from ${previousFieldCount} to ${currentFieldCount}`);
    }

    previousFieldCount = currentFieldCount;
    await page.waitForTimeout(500);
  }

  log(`form: timeout waiting for stability, final count: ${previousFieldCount}`);
  return false;
}

async function debugFormFields(page) {
  try {
    const fields = await page.evaluate(() => {
      const inputs = Array.from(document.querySelectorAll('input, select, textarea'));
      return inputs.map(input => ({
        tag: input.tagName.toLowerCase(),
        type: input.type || 'text',
        name: input.name || '',
        id: input.id || '',
        placeholder: input.placeholder || '',
        label: input.labels?.[0]?.textContent?.trim() || '',
        ariaLabel: input.getAttribute('aria-label') || '',
        dataField: input.getAttribute('data-field') || '',
        dataName: input.getAttribute('data-name') || '',
        className: input.className || '',
        visible: input.offsetParent !== null
      })).filter(field => field.visible);
    });

    log(`debug: found ${fields.length} visible form fields:`);
    fields.forEach(field => {
      log(`  ${field.tag}[type="${field.type}"] name="${field.name}" id="${field.id}" placeholder="${field.placeholder}" label="${field.label}" aria-label="${field.ariaLabel}" data-field="${field.dataField}" data-name="${field.dataName}" class="${field.className}"`);
    });

    // Check for any fields that might contain common field type keywords in any attribute
    const commonFieldTypes = ['linkedin', 'github', 'twitter', 'facebook', 'instagram', 'portfolio', 'website', 'url', 'phone', 'email', 'salary', 'experience', 'education', 'skills'];
    const detectedFields = {};

    commonFieldTypes.forEach(fieldType => {
      const matchingFields = fields.filter(field =>
        field.name.toLowerCase().includes(fieldType) ||
        field.id.toLowerCase().includes(fieldType) ||
        field.placeholder.toLowerCase().includes(fieldType) ||
        field.label.toLowerCase().includes(fieldType) ||
        field.ariaLabel.toLowerCase().includes(fieldType) ||
        field.dataField.toLowerCase().includes(fieldType) ||
        field.dataName.toLowerCase().includes(fieldType)
      );

      if (matchingFields.length > 0) {
        detectedFields[fieldType] = matchingFields;
      }
    });

    if (Object.keys(detectedFields).length > 0) {
      log(`debug: found fields matching common types:`);
      Object.entries(detectedFields).forEach(([fieldType, matchingFields]) => {
        log(`  ${fieldType.toUpperCase()}: ${matchingFields.length} field(s)`);
        matchingFields.forEach(field => {
          log(`    ${field.tag}[type="${field.type}"] name="${field.name}" id="${field.id}" placeholder="${field.placeholder}" label="${field.label}"`);
        });
      });
    } else {
      log(`debug: no fields found matching common field type keywords`);
    }
  } catch (e) {
    log(`debug: error analyzing form fields: ${e.message}`);
  }
}

/* --------------------------- field label registry --------------------------- */

const L = {
  firstName: ['First name', 'Given name', 'Vorname', 'Prénom', 'First Name', 'Firstname'],
  lastName: ['Last name', 'Family name', 'Surname', 'Nachname', 'Nom', 'Last Name', 'Lastname'],
  fullName: ['Full name', 'Your full name', 'Name (full)', 'Full Name', 'Name'],
  phone: ['Phone', 'Phone number', 'Telefon', 'Téléphone', 'Phone Number', 'Mobile', 'Telephone'],
  email: ['Email', 'E-mail', 'Email address', 'E-Mail', 'E-mail address', 'Email Address'],
  gender: ['Gender', 'Gender to which you identify as', 'Geschlecht'],
  personalUrl: ['Personal URL', 'Website', 'Portfolio', 'Personal site', 'Homepage', 'Website URL'],
  cv: ['Curriculum vitae', 'CV', 'Resume', 'Lebenslauf', 'Resume/CV', 'Cover Letter'],
  country: ['What country do you currently live in', 'Country', 'Current country', 'Location'],
  tax: ['Tax residence', 'Where is your tax residence'],
  notice: ['Notice period', 'What is your notice period'],
  salary: ['Salary expectations', 'What are your salary expectations', 'Salary (EUR)', 'Expected salary', 'Salary'],
  referred: ['Were you referred', 'Referral', 'Referred by'],
  linkedin: ['LinkedIn', 'LinkedIn profile', 'LinkedIn URL', 'LinkedIn Profile'],
  github: ['GitHub', 'GitHub profile', 'GitHub URL', 'GitHub Profile', 'Github', 'Github profile']
};

// strict selectors for name split / fullname
const FIRST_SELECTORS = [
  'input[name*=first i]', 'input[id*=first i]', 'input[placeholder*=first i]',
  'input[name*="firstName"]', 'input[id*="firstName"]',
  'input[name*="first_name"]', 'input[id*="first_name"]'
];
const LAST_SELECTORS = [
  'input[name*=last i]', 'input[id*=last i]', 'input[placeholder*=last i]',
  'input[name*="lastName"]', 'input[id*="lastName"]',
  'input[name*="last_name"]', 'input[id*="last_name"]'
];
const FULLNAME_STRICT = [
  'input[autocomplete="name"]',
  'input[name="fullName"]', 'input[id="fullName"]',
  'input[name="fullname"]', 'input[id="fullname"]',
  'input[placeholder*="full name" i]',
  'input[aria-label*="full name" i]',
  'input[name*="full_name"]', 'input[id*="full_name"]'
];

// Helper function to generate selectors for any field type
function generateFieldSelectors(fieldType, variations = []) {
  const baseSelectors = [
    `input[name*="${fieldType}" i]`,
    `input[id*="${fieldType}" i]`,
    `input[placeholder*="${fieldType}" i]`,
    `input[data-field*="${fieldType}" i]`,
    `input[data-name*="${fieldType}" i]`
  ];

  // Add variations (e.g., "linked_in", "git_hub", etc.)
  variations.forEach(variation => {
    baseSelectors.push(
      `input[name*="${variation}" i]`,
      `input[id*="${variation}" i]`,
      `input[placeholder*="${variation}" i]`,
      `input[data-field*="${variation}" i]`,
      `input[data-name*="${variation}" i]`
    );
  });

  return baseSelectors;
}

// Generic form field selectors - now using the helper function for consistency
const GENERIC_SELECTORS = {
  email: [
    'input[type="email"]',
    ...generateFieldSelectors('email')
  ],
  phone: [
    'input[type="tel"]',
    ...generateFieldSelectors('phone', ['mobile', 'telephone'])
  ],
  salary: [
    ...generateFieldSelectors('salary'),
    'select[name*="salary" i]',
    'select[id*="salary" i]'
  ],
  linkedin: generateFieldSelectors('linkedin', ['linked_in', 'social_linkedin', 'profile_linkedin', 'url_linkedin']),
  github: generateFieldSelectors('github', ['git_hub', 'social_github', 'profile_github', 'url_github']),
  website: generateFieldSelectors('website', ['portfolio', 'url', 'homepage']),
  twitter: generateFieldSelectors('twitter', ['social_twitter', 'profile_twitter', 'url_twitter']),
  facebook: generateFieldSelectors('facebook', ['social_facebook', 'profile_facebook', 'url_facebook']),
  instagram: generateFieldSelectors('instagram', ['social_instagram', 'profile_instagram', 'url_instagram']),
  experience: generateFieldSelectors('experience', ['work_experience', 'job_experience', 'professional_experience']),
  education: generateFieldSelectors('education', ['educational_background', 'academic_background']),
  skills: generateFieldSelectors('skills', ['technical_skills', 'professional_skills', 'competencies'])
};

/* ---------------------------------- runner ---------------------------------- */

export async function runBatch(urls) {

  await ensureOutFiles();
  const user = await loadUser();

  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();

  log(`batch: starting ${urls.length} URL(s)`);

  try {
    let i = 0;
    for (const url of urls) {
      i += 1;
      const tsStart = new Date().toISOString();
      const jobId = crypto.createHash('sha1').update(url + tsStart).digest('hex').slice(0, 12);
      const t0 = Date.now();
      log(`\n--- job ${i}/${urls.length} ---`);
      log(`nav: ${url}`);

      let status = 'error';
      let notes = '';
      let meta = { company: '', title: '', source: 'Other' };

      try {
        await page.goto(url, { waitUntil: 'domcontentloaded' });
        // Give late-loaded frameworks a moment
        await page.waitForTimeout(1200);
        meta = await extractMeta(page);
        log(`meta: company="${meta.company}" title="${meta.title}" source=${meta.source}`);

        // Wait for form stability - this works for any platform
        const isStable = await waitForFormStability(page);
        if (!isStable) {
          log('form: form may still be loading, proceeding with current state');
        }

        // Debug form fields to understand structure
        await debugFormFields(page);

        /* -------- Names: prefer First+Last; only use Full name if both absent and full present -------- */
        const firstSel = await findFirstVisibleSelector(page, FIRST_SELECTORS, 'firstName');
        const lastSel = await findFirstVisibleSelector(page, LAST_SELECTORS, 'lastName');
        const fullSel = await findFirstVisibleSelector(page, FULLNAME_STRICT, 'fullName (strict)');

        if (firstSel && lastSel) {
          await page.fill(firstSel, user.firstName).catch(() => { });
          log(`fill: ok   firstName→${firstSel}`);
          await page.fill(lastSel, user.lastName).catch(() => { });
          log(`fill: ok   lastName →${lastSel}`);
        } else if (!firstSel && !lastSel && fullSel) {
          const fullName = `${user.firstName} ${user.lastName}`;
          await page.fill(fullSel, fullName).catch(() => { });
          log(`fill: ok   fullName→${fullSel}`);
        } else {
          // Try label-driven first/last as fallback
          await fillTextByLabel(page, L.firstName, user.firstName, 'firstName');
          await fillTextByLabel(page, L.lastName, user.lastName, 'lastName');
        }

        /* ------------------------------ Contact / Links ------------------------------ */
        // Try generic selectors first for all forms
        let emailFilled = await fillGenericField(page, 'email', user.email, 'email');
        let phoneFilled = await fillGenericField(page, 'phone', user.phone, 'phone');
        let salaryFilled = await fillGenericField(page, 'salary', user.salary, 'salary');
        let linkedinFilled = await fillGenericField(page, 'linkedin', user.linkedin || '', 'linkedin');
        let githubFilled = await fillGenericField(page, 'github', user.github || '', 'github');
        let websiteFilled = await fillGenericField(page, 'website', user.website || '', 'website');

        // Fallback to label-based filling if generic selectors didn't work
        if (!emailFilled) await fillTextByLabel(page, L.email, user.email, 'email');
        if (!phoneFilled) await fillTextByLabel(page, L.phone, user.phone, 'phone');
        if (!salaryFilled) await fillTextByLabel(page, L.salary, user.salary, 'salary');
        if (!linkedinFilled) await fillTextByLabel(page, L.linkedin, user.linkedin || '', 'linkedin');
        if (!githubFilled) await fillTextByLabel(page, L.github, user.github || '', 'github');
        if (!websiteFilled) await fillTextByLabel(page, L.personalUrl, user.website || user.linkedin || '', 'personalUrl');

        // Last resort: try to find any URL fields that might be for social media
        if (!linkedinFilled && user.linkedin) {
          try {
            const urlFields = page.locator('input[type="url"], input[placeholder*="url" i], input[name*="url" i]');
            const count = await urlFields.count();
            if (count > 0) {
              // Try the first URL field as a fallback for LinkedIn
              await urlFields.first().fill(user.linkedin);
              log(`fallback: filled LinkedIn URL in first URL field`);
              linkedinFilled = true;
            }
          } catch { }
        }

        /* ----------------------------------- Upload ---------------------------------- */
        await setFileByLabel(page, L.cv, user.resumePath, 'cv');

        /* ----------------------------- Questions / selects ---------------------------- */
        // Gender (example choose Female if preferred)
        if (user.gender) {
          await clickRadioByLabel(page, L.gender, user.gender, 'gender');
        }
        // Country & Tax residence
        await selectByLabel(page, L.country, user.location || 'Germany', 'country');
        await selectByLabel(page, L.tax, user.taxResidence || 'Germany', 'tax');

        // Notice period
        const noticeVal = user.noticePeriod || 'Immediate';
        await fillTextByLabel(page, L.notice, noticeVal, 'notice');

        // Salary expectations (EUR)
        const salaryVal = user.salary || 'Flexible';
        await fillTextByLabel(page, L.salary, salaryVal, 'salary');

        // Referral
        await fillTextByLabel(page, L.referred, user.referredBy || '', 'referred');

        /* --------------------------------- Submit step -------------------------------- */
        status = 'filled';
        notes = 'form filled, waiting for manual submission and tab close';
        log('submit: form filled, user must manually submit and close tab');

        // Show banner to guide user
        await showHoldBanner(
          page,
          'EasyApply: Fill missing fields and submit. When done, CLOSE this tab to continue the batch.'
        );

        // Wait for the page to be closed (user closes tab after submitting)
        try {
          await page.waitForEvent('close', { timeout: 0 }); // Wait indefinitely until tab is closed
          status = 'submitted';
          notes = 'form submitted and tab closed by user';
          log('submit: tab closed by user, marking as submitted');
        } catch (e) {
          // If there's an error waiting for close (shouldn't happen with timeout: 0)
          status = 'error';
          notes = 'error waiting for tab close';
          log('submit: error waiting for tab close');
        }
      } catch (e) {
        status = 'error';
        notes = e?.message || 'unknown error';
        console.error('[easyapply] ERROR:', e?.stack || e);
      }

      const tsEnd = new Date().toISOString();
      const dur = ((Date.now() - t0) / 1000).toFixed(1);
      await appendCsv({
        tsStart, tsEnd, status,
        company: meta.company, title: meta.title, source: meta.source,
        url, resume: user.resumePath, notes, jobId
      });
      log(`done: status=${status} duration=${dur}s`);
    }
  } finally {
    await context.close();
    await browser.close();
    log('batch: finished');
  }
}
