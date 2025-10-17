/**
 * JobBot Runner - Automated job application form filler
 * 
 * This module handles the automated filling of job application forms across
 * various platforms (LinkedIn, Greenhouse, Lever, Workday, etc.)
 */

import { chromium } from 'playwright';
import { promises as fs } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

// Path configuration
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const CONFIG_PATH = resolve(__dirname, '..', 'config', 'user.json');
const OUT_DIR = resolve(__dirname, '..', 'output');
const CSV_PATH = resolve(OUT_DIR, 'applied.csv');

// Logging utility
const log = (...args) => console.log('[easyapply]', ...args);

// ============================================================================
// FILE MANAGEMENT & LOGGING
// ============================================================================

/**
 * Ensures output directory and CSV file exist with proper headers
 */
async function ensureOutFiles() {
  await fs.mkdir(OUT_DIR, { recursive: true }).catch(() => { });

  try {
    await fs.access(CSV_PATH);
  } catch {
    const csvHeader = 'version,timestamp_start,timestamp_end,status,company,job_title,source,url,resume_used,notes,job_id\n';
    await fs.writeFile(CSV_PATH, csvHeader, 'utf8');
  }
}

/**
 * Escapes CSV values to prevent injection and formatting issues
 */
const escapeCsvValue = (value) => {
  const stringValue = String(value ?? '');
  return /[",\n]/.test(stringValue) ? `"${stringValue.replace(/"/g, '""')}"` : stringValue;
};

/**
 * Appends a job application record to the CSV file
 */
async function appendCsv(row) {
  const csvLine = [
    1, // version
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
  ].map(escapeCsvValue).join(',') + '\n';

  await fs.appendFile(CSV_PATH, csvLine, 'utf8');
}

// ============================================================================
// CONFIGURATION
// ============================================================================

/**
 * Loads and validates user configuration from config/user.json
 */
async function loadUser() {
  const rawConfig = await fs.readFile(CONFIG_PATH, 'utf8');
  const userConfig = JSON.parse(rawConfig);

  // Validate required fields
  const requiredFields = ['firstName', 'lastName', 'email', 'resumePath'];
  for (const field of requiredFields) {
    if (!userConfig[field]) {
      throw new Error(`Missing required field "${field}" in ${CONFIG_PATH}`);
    }
  }

  // Resolve resume path to absolute path
  userConfig.resumePath = resolve(__dirname, '..', userConfig.resumePath);
  return userConfig;
}

// ============================================================================
// PAGE METADATA EXTRACTION
// ============================================================================

/**
 * Extracts job posting metadata from the current page
 */
async function extractMeta(page) {
  try {
    const pageData = await page.evaluate(() => {
      // Helper to get content from meta tags or elements
      const getContent = (selector) => {
        const element = document.querySelector(selector);
        return element?.content || element?.innerText || null;
      };

      // Extract title from various sources
      const ogTitle = getContent('meta[property="og:title"]');
      const twitterTitle = getContent('meta[name="twitter:title"]');
      const h1Title = document.querySelector('h1')?.innerText || null;
      const pageTitle = document.title || '';

      const title = (ogTitle || twitterTitle || h1Title || pageTitle)
        .trim()
        .slice(0, 160);

      const siteName = getContent('meta[property="og:site_name"]');

      // Extract company from JSON-LD structured data
      let company = null;
      const jsonLdScripts = document.querySelectorAll('script[type="application/ld+json"]');

      for (const script of jsonLdScripts) {
        try {
          const data = JSON.parse(script.textContent || '{}');
          const items = Array.isArray(data) ? data : [data];

          for (const item of items) {
            if (item['@type'] === 'JobPosting' && item.hiringOrganization?.name) {
              company = item.hiringOrganization.name;
              break;
            }
          }
          if (company) break;
        } catch {
          // Ignore invalid JSON
        }
      }

      return { title, siteName, company };
    });

    // Determine job board source from URL
    const hostname = new URL(page.url()).hostname;
    const source = getJobBoardSource(hostname);

    // Finalize company and title
    const company = pageData.company || pageData.siteName || hostname.replace(/^www\./, '');
    const title = pageData.title || '';

    return { company, title, source };
  } catch {
    return { company: '', title: '', source: 'Other' };
  }
}

/**
 * Determines the job board source based on hostname
 */
function getJobBoardSource(hostname) {
  const sourceMap = {
    'greenhouse.io': 'Greenhouse',
    'lever.co': 'Lever',
    'myworkdayjobs': 'Workday',
    'personio': 'Personio',
    'join.com': 'Personio',
    'smartrecruiters': 'SmartRecruiters',
    'linkedin.com': 'LinkedIn'
  };

  for (const [domain, source] of Object.entries(sourceMap)) {
    if (hostname.includes(domain)) {
      return source;
    }
  }

  return 'Other';
}

// ============================================================================
// FORM FILLING HELPERS
// ============================================================================
// These utilities prioritize accessibility-first approaches (getByLabel/getByRole)
// then fall back to heuristic-based selectors for maximum compatibility

/**
 * Fills a text input field by matching against provided labels
 */
async function fillTextByLabel(page, labels, value, fieldName) {
  if (!value) {
    log(`fill: skip ${fieldName} – empty value`);
    return false;
  }

  // Try label-based approach first (most reliable)
  for (const label of labels) {
    try {
      const input = page.getByLabel(label, { exact: false });
      if (await input.count()) {
        await input.first().fill(value);
        log(`fill: ok   ${fieldName} via label "${label}"`);
        return true;
      }
    } catch {
      // Continue to next label
    }
  }

  // Fallback: try role-based approach
  for (const label of labels) {
    try {
      const textbox = page.getByRole('textbox', { name: label, exact: false });
      if (await textbox.count()) {
        await textbox.first().fill(value);
        log(`fill: ok   ${fieldName} via role name "${label}"`);
        return true;
      }
    } catch {
      // Continue to next label
    }
  }

  log(`fill: miss ${fieldName}`);
  return false;
}

/**
 * Clicks a radio button by matching against provided labels and option text
 */
async function clickRadioByLabel(page, labels, optionText, fieldName) {
  if (!optionText) {
    return false;
  }

  // Try grouped radio buttons first (e.g., Gender group with Male/Female options)
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
    } catch {
      // Continue to next group
    }
  }

  // Global fallback: try to find radio button anywhere on page
  try {
    const radio = page.getByRole('radio', { name: optionText, exact: false }).first();
    if (await radio.count()) {
      await radio.check().catch(async () => await radio.click());
      log(`radio: ok   ${fieldName}="${optionText}" (global)`);
      return true;
    }
  } catch {
    // No radio button found
  }

  log(`radio: miss ${fieldName}="${optionText}"`);
  return false;
}

/**
 * Selects an option in a dropdown/select field by matching against provided labels
 */
async function selectByLabel(page, labels, value, fieldName) {
  if (!value) {
    log(`select: skip ${fieldName} – empty value`);
    return false;
  }

  // Try label-based select elements first
  for (const label of labels) {
    try {
      const select = page.getByLabel(label, { exact: false });
      if (await select.count()) {
        const element = select.first();
        try {
          // Try different selection methods
          await element.selectOption({ label: value }).catch(async () => {
            await element.selectOption({ value }).catch(async () => {
              await element.fill(value);
            });
          });
          log(`select: ok   ${fieldName}="${value}" via label "${label}"`);
          return true;
        } catch {
          // Continue to next label
        }
      }
    } catch {
      // Continue to next label
    }
  }

  // Fallback: try combobox role
  for (const label of labels) {
    try {
      const combobox = page.getByRole('combobox', { name: label, exact: false });
      if (await combobox.count()) {
        const element = combobox.first();
        await element.fill(value).catch(async () => await element.pressSequentially(value));
        log(`select: ok   ${fieldName} via combobox "${label}" (typed)`);
        return true;
      }
    } catch {
      // Continue to next label
    }
  }

  log(`select: miss ${fieldName}`);
  return false;
}

/**
 * Uploads a file to a file input field by matching against provided labels
 */
async function setFileByLabel(page, labels, filePath, fieldName) {
  if (!filePath) {
    return false;
  }

  // Try label-based file inputs first
  for (const label of labels) {
    try {
      const fileInput = page.getByLabel(label, { exact: false });
      if (await fileInput.count()) {
        const element = fileInput.first();
        await element.setInputFiles(filePath);
        log(`upload: ok   ${fieldName} via label "${label}"`);
        return true;
      }
    } catch {
      // Continue to next label
    }
  }

  // Fallback: try any file input on the page
  try {
    const fileInputs = page.locator('input[type=file]');
    if (await fileInputs.count()) {
      await fileInputs.first().setInputFiles(filePath);
      log(`upload: ok   ${fieldName} via generic file input`);
      return true;
    }
  } catch {
    // No file inputs found
  }

  log(`upload: miss ${fieldName}`);
  return false;
}

/**
 * Finds the first visible element matching any of the provided selectors
 */
async function findFirstVisibleSelector(page, selectors, label) {
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    try {
      if (await locator.count()) {
        const isVisible = await locator.isVisible().catch(() => true);
        if (isVisible) {
          log(`detect: found ${label} via ${selector}`);
          return selector;
        }
      }
    } catch {
      // Continue to next selector
    }
  }

  log(`detect: no ${label} found`);
  return null;
}

/**
 * Fills a field using generic selectors based on field type
 * Works for any field type (email, phone, linkedin, github, etc.)
 */
async function fillGenericField(page, fieldType, value, fieldName) {
  if (!value) {
    log(`generic: skip ${fieldName} – empty value`);
    return false;
  }

  // Try predefined selectors for this field type
  const selectors = GENERIC_SELECTORS[fieldType] || [];
  for (const selector of selectors) {
    try {
      const locator = page.locator(selector).first();
      if (await locator.count()) {
        const isVisible = await locator.isVisible().catch(() => true);
        if (isVisible) {
          await locator.fill(value);
          log(`generic: ok   ${fieldName} via ${selector}`);
          return true;
        }
      }
    } catch {
      // Continue to next selector
    }
  }

  // Fallback: look for fields near text that contains the field name
  try {
    const fieldText = fieldType.toLowerCase();
    const nearbyInput = page.locator(`text=${fieldText} >> .. >> input`).first();
    if (await nearbyInput.count()) {
      const isVisible = await nearbyInput.isVisible().catch(() => true);
      if (isVisible) {
        await nearbyInput.fill(value);
        log(`generic: ok   ${fieldName} via nearby text "${fieldText}"`);
        return true;
      }
    }
  } catch {
    // No nearby input found
  }

  log(`generic: miss ${fieldName}`);
  return false;
}

/**
 * Displays a banner on the page to guide the user after form filling
 */
async function showHoldBanner(page, message = 'Review & finish any missing fields, then submit. When done, CLOSE this tab to continue.') {
  await page.evaluate((msg) => {
    // Avoid duplicate banners
    if (document.getElementById('__ea_hold_banner')) {
      return;
    }

    const banner = document.createElement('div');
    banner.id = '__ea_hold_banner';
    banner.textContent = msg;

    // Style the banner
    Object.assign(banner.style, {
      position: 'fixed',
      right: '16px',
      bottom: '16px',
      zIndex: '2147483647',
      background: 'rgba(17,24,39,0.96)',
      color: '#fff',
      padding: '10px 12px',
      borderRadius: '10px',
      font: '13px/1.3 system-ui, -apple-system, Segoe UI, Roboto, sans-serif',
      boxShadow: '0 6px 24px rgba(0,0,0,0.3)'
    });

    document.body.appendChild(banner);
  }, message);
}

/**
 * Waits for the form to stabilize (no new fields being added)
 * This helps ensure all dynamic content has loaded before filling
 */
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
      if (stableCount >= 3) { // Stable for 3 consecutive checks
        const elapsed = Date.now() - startTime;
        log(`form: stable with ${currentFieldCount} fields after ${elapsed}ms`);
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

/**
 * Analyzes and logs information about form fields for debugging purposes
 */
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

    // Check for fields matching common field type keywords
    const commonFieldTypes = [
      'linkedin', 'github', 'twitter', 'facebook', 'instagram',
      'portfolio', 'website', 'url', 'phone', 'email', 'salary',
      'experience', 'education', 'skills'
    ];

    const detectedFields = {};
    commonFieldTypes.forEach(fieldType => {
      const matchingFields = fields.filter(field => {
        const searchText = [
          field.name, field.id, field.placeholder, field.label,
          field.ariaLabel, field.dataField, field.dataName
        ].join(' ').toLowerCase();

        return searchText.includes(fieldType);
      });

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
  } catch (error) {
    log(`debug: error analyzing form fields: ${error.message}`);
  }
}

// ============================================================================
// FIELD LABEL REGISTRY
// ============================================================================
// Common label variations for form fields across different job boards

const FIELD_LABELS = {
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

// ============================================================================
// FIELD SELECTORS
// ============================================================================
// Specific selectors for name fields (first, last, full name)

const FIRST_NAME_SELECTORS = [
  'input[name*=first i]', 'input[id*=first i]', 'input[placeholder*=first i]',
  'input[name*="firstName"]', 'input[id*="firstName"]',
  'input[name*="first_name"]', 'input[id*="first_name"]'
];

const LAST_NAME_SELECTORS = [
  'input[name*=last i]', 'input[id*=last i]', 'input[placeholder*=last i]',
  'input[name*="lastName"]', 'input[id*="lastName"]',
  'input[name*="last_name"]', 'input[id*="last_name"]'
];

const FULL_NAME_SELECTORS = [
  'input[autocomplete="name"]',
  'input[name="fullName"]', 'input[id="fullName"]',
  'input[name="fullname"]', 'input[id="fullname"]',
  'input[placeholder*="full name" i]',
  'input[aria-label*="full name" i]',
  'input[name*="full_name"]', 'input[id*="full_name"]'
];

/**
 * Generates CSS selectors for a given field type with optional variations
 * This creates consistent selector patterns for any field type
 */
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

/**
 * Generic form field selectors for various field types
 * Uses the helper function for consistent selector generation
 */
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

// ============================================================================
// MAIN RUNNER
// ============================================================================

/**
 * Main function to process a batch of job application URLs
 */
export async function runBatch(urls) {
  await ensureOutFiles();
  const user = await loadUser();

  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();

  log(`batch: starting ${urls.length} URL(s)`);

  try {
    for (let i = 0; i < urls.length; i++) {
      const url = urls[i];
      const jobNumber = i + 1;
      const tsStart = new Date().toISOString();
      const jobId = crypto.createHash('sha1').update(url + tsStart).digest('hex').slice(0, 12);
      const startTime = Date.now();

      log(`\n--- job ${jobNumber}/${urls.length} ---`);
      log(`nav: ${url}`);

      let status = 'error';
      let notes = '';
      let meta = { company: '', title: '', source: 'Other' };

      try {
        await page.goto(url, { waitUntil: 'domcontentloaded' });
        // Give late-loaded frameworks a moment to initialize
        await page.waitForTimeout(1200);

        meta = await extractMeta(page);
        log(`meta: company="${meta.company}" title="${meta.title}" source=${meta.source}`);

        // Wait for form stability - ensures all dynamic content has loaded
        const isStable = await waitForFormStability(page);
        if (!isStable) {
          log('form: form may still be loading, proceeding with current state');
        }

        // Debug form fields to understand structure
        await debugFormFields(page);

        // ========================================================================
        // NAME FIELDS: Prefer First+Last; use Full name only if both absent
        // ========================================================================
        const firstSelector = await findFirstVisibleSelector(page, FIRST_NAME_SELECTORS, 'firstName');
        const lastSelector = await findFirstVisibleSelector(page, LAST_NAME_SELECTORS, 'lastName');
        const fullSelector = await findFirstVisibleSelector(page, FULL_NAME_SELECTORS, 'fullName (strict)');

        if (firstSelector && lastSelector) {
          await page.fill(firstSelector, user.firstName).catch(() => { });
          log(`fill: ok   firstName→${firstSelector}`);
          await page.fill(lastSelector, user.lastName).catch(() => { });
          log(`fill: ok   lastName →${lastSelector}`);
        } else if (!firstSelector && !lastSelector && fullSelector) {
          const fullName = `${user.firstName} ${user.lastName}`;
          await page.fill(fullSelector, fullName).catch(() => { });
          log(`fill: ok   fullName→${fullSelector}`);
        } else {
          // Try label-driven first/last as fallback
          await fillTextByLabel(page, FIELD_LABELS.firstName, user.firstName, 'firstName');
          await fillTextByLabel(page, FIELD_LABELS.lastName, user.lastName, 'lastName');
        }

        // ========================================================================
        // CONTACT & SOCIAL LINKS: Try generic selectors first, then label-based
        // ========================================================================
        const emailFilled = await fillGenericField(page, 'email', user.email, 'email');
        const phoneFilled = await fillGenericField(page, 'phone', user.phone, 'phone');
        const salaryFilled = await fillGenericField(page, 'salary', user.salary, 'salary');
        const linkedinFilled = await fillGenericField(page, 'linkedin', user.linkedin || '', 'linkedin');
        const githubFilled = await fillGenericField(page, 'github', user.github || '', 'github');
        const websiteFilled = await fillGenericField(page, 'website', user.website || '', 'website');

        // Fallback to label-based filling if generic selectors didn't work
        if (!emailFilled) await fillTextByLabel(page, FIELD_LABELS.email, user.email, 'email');
        if (!phoneFilled) await fillTextByLabel(page, FIELD_LABELS.phone, user.phone, 'phone');
        if (!salaryFilled) await fillTextByLabel(page, FIELD_LABELS.salary, user.salary, 'salary');
        if (!linkedinFilled) await fillTextByLabel(page, FIELD_LABELS.linkedin, user.linkedin || '', 'linkedin');
        if (!githubFilled) await fillTextByLabel(page, FIELD_LABELS.github, user.github || '', 'github');
        if (!websiteFilled) await fillTextByLabel(page, FIELD_LABELS.personalUrl, user.website || user.linkedin || '', 'personalUrl');

        // Last resort: try to find any URL fields that might be for social media
        if (!linkedinFilled && user.linkedin) {
          try {
            const urlFields = page.locator('input[type="url"], input[placeholder*="url" i], input[name*="url" i]');
            const count = await urlFields.count();
            if (count > 0) {
              // Try the first URL field as a fallback for LinkedIn
              await urlFields.first().fill(user.linkedin);
              log(`fallback: filled LinkedIn URL in first URL field`);
            }
          } catch {
            // No URL fields found
          }
        }

        // ========================================================================
        // FILE UPLOAD
        // ========================================================================
        await setFileByLabel(page, FIELD_LABELS.cv, user.resumePath, 'cv');

        // ========================================================================
        // ADDITIONAL QUESTIONS & SELECTS
        // ========================================================================
        // Gender selection
        if (user.gender) {
          await clickRadioByLabel(page, FIELD_LABELS.gender, user.gender, 'gender');
        }

        // Location and tax residence
        await selectByLabel(page, FIELD_LABELS.country, user.location || 'Germany', 'country');
        await selectByLabel(page, FIELD_LABELS.tax, user.taxResidence || 'Germany', 'tax');

        // Notice period
        const noticeValue = user.noticePeriod || 'Immediate';
        await fillTextByLabel(page, FIELD_LABELS.notice, noticeValue, 'notice');

        // Salary expectations
        const salaryValue = user.salary || 'Flexible';
        await fillTextByLabel(page, FIELD_LABELS.salary, salaryValue, 'salary');

        // Referral information
        await fillTextByLabel(page, FIELD_LABELS.referred, user.referredBy || '', 'referred');

        // ========================================================================
        // SUBMISSION & COMPLETION
        // ========================================================================
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
        } catch (error) {
          // If there's an error waiting for close (shouldn't happen with timeout: 0)
          status = 'error';
          notes = 'error waiting for tab close';
          log('submit: error waiting for tab close');
        }
      } catch (error) {
        status = 'error';
        notes = error?.message || 'unknown error';
        console.error('[easyapply] ERROR:', error?.stack || error);
      }

      // Record the job application result
      const tsEnd = new Date().toISOString();
      const duration = ((Date.now() - startTime) / 1000).toFixed(1);
      await appendCsv({
        tsStart, tsEnd, status,
        company: meta.company, title: meta.title, source: meta.source,
        url, resume: user.resumePath, notes, jobId
      });
      log(`done: status=${status} duration=${duration}s`);
    }
  } finally {
    await context.close();
    await browser.close();
    log('batch: finished');
  }
}

