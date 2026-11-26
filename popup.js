const $ = (id) => document.getElementById(id);
const FIELDS = ['key', 'model'];

chrome.storage.local.get([...FIELDS, 'draft'], (s) => {
  FIELDS.forEach((f) => s[f] && ($(f).value = s[f]));
  if (s.draft) $('text').value = s.draft;
  if (!s.key) $('settings').open = true; // first run: show where the key goes
});
FIELDS.forEach((f) => $(f).addEventListener('change', () => chrome.storage.local.set({ [f]: $(f).value.trim() })));
// Popup is destroyed when it loses focus, so save the draft on every keystroke.
$('text').addEventListener('input', () => chrome.storage.local.set({ draft: $('text').value }));

const status = (t, kind = '') => {
  $('status').textContent = t;
  $('status').className = kind;
};

$('toggleKey').onclick = () => {
  const hidden = $('key').type === 'password';
  $('key').type = hidden ? 'text' : 'password';
  $('toggleKey').textContent = hidden ? 'Hide' : 'Show';
};

$('text').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) $('go').click();
});

$('go').onclick = async () => {
  const key = $('key').value.trim();
  const text = $('text').value.trim();
  if (!key) { $('settings').open = true; return status('Enter your Sarvam API key first.', 'err'); }
  if (!text) return status('Write something first.', 'err');

  $('go').disabled = true;
  try {
    status('Asking Sarvam AI...');
    const fixed = await askSarvam(key, $('model').value.trim() || 'sarvam-105b', text);

    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    let inserted = false;
    try {
      [{ result: inserted }] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: insertAtCursor, args: [fixed] });
    } catch { /* chrome:// pages, web store etc. can't be scripted */ }

    if (inserted) {
      await chrome.storage.local.remove('draft');
      return window.close(); // popup closes, cursor is back in the field
    }
    await navigator.clipboard.writeText(fixed);
    status(`No focused text box on the page, so it was copied to your clipboard:\n\n${fixed}`, 'ok');
  } catch (e) {
    status('Error: ' + e.message, 'err');
  } finally {
    $('go').disabled = false;
  }
};

async function askSarvam(key, model, text) {
  const system = `You rewrite rough, broken or half-formed text into clear, natural, grammatically correct English.
Rules:
- Keep the writer's meaning, intent, tone and point of view. Do not add facts, greetings or sign-offs they did not imply.
- Fix grammar, spelling, punctuation and word choice; expand shorthand (pls, tmrw, u) into proper words.
- Keep it about the same length; do not pad.
- If the input is in Hinglish or another language mixed with English, write the result in English.
- Return ONLY the rewritten text. No quotes, no explanation, no alternatives.`;

  const res = await fetch('https://api.sarvam.ai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'api-subscription-key': key },
    body: JSON.stringify({
      model,
      reasoning_effort: 'low',
      max_tokens: 8000, // reasoning eats tokens; too low = empty answer
      messages: [{ role: 'system', content: system }, { role: 'user', content: text }],
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message || res.statusText);
  const choice = data.choices[0];
  const out = (choice.message.content || '')
    .replace(/<think>[\s\S]*?<\/think>/g, '')
    .trim()
    .replace(/^["“](.*)["”]$/s, '$1');
  if (!out) throw new Error(choice.finish_reason === 'length' ? 'AI ran out of tokens before answering. Try again.' : 'AI returned an empty answer.');
  return out;
}

// ---- Injected into the page (must be self-contained) ----
// ponytail: top frame only; text boxes inside iframes fall back to clipboard. Add allFrames probing if that matters.
function insertAtCursor(text) {
  const el = document.activeElement;
  if (!el) return false;
  const isInput = el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' && /^(text|search|email|url|tel)$/.test(el.type));
  if (!isInput && !el.isContentEditable) return false;
  if (el.disabled || el.readOnly) return false;

  el.focus();

  if (el.isContentEditable) {
    // Rich editors (Lexical, Draft.js, Slate, ProseMirror...) keep their own model; execCommand edits the DOM
    // behind their back and the text shows twice until posted. A synthetic paste goes through their own handler.
    const dt = new DataTransfer();
    dt.setData('text/plain', text);
    const paste = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true });
    if (!el.dispatchEvent(paste)) return true; // editor handled it (called preventDefault)
  }

  // Plain inputs / simple contenteditable: execCommand keeps Ctrl+Z working and fires input events.
  if (document.execCommand('insertText', false, text)) return true;

  if (isInput) {
    el.setRangeText(text, el.selectionStart ?? el.value.length, el.selectionEnd ?? el.value.length, 'end');
  } else {
    const sel = getSelection();
    if (!sel.rangeCount || !el.contains(sel.anchorNode)) return false;
    const range = sel.getRangeAt(0);
    range.deleteContents();
    range.insertNode(document.createTextNode(text));
    range.collapse(false);
  }
  el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
  return true;
}
