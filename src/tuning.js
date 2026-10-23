// Live tuning panel, after space-miner's: a collapsible section per group with a slider per value. Sliders
// edit the same config objects the game reads every frame. "Copy" puts the values on the clipboard (or in a
// text box when that's blocked) in the form "Section: key value, ..." to paste back as new defaults.
//
// spec: [[title, [[object, key, label, min, max, step], ...]], ...]; an item [object, key, label, 'color'] is a
// colour picker for a '#rrggbb' value.

const CLOSED_KEY = 'godGame.tuneClosed';
const closed = (() => { try { return new Set(JSON.parse(localStorage.getItem(CLOSED_KEY) || '[]')); } catch (err) { return new Set(); } })();
const saveClosed = () => { try { localStorage.setItem(CLOSED_KEY, JSON.stringify([...closed])); } catch (err) { /* storage blocked */ } };

const decimals = (step) => Math.max(0, -Math.floor(Math.log10(step) + 1e-9));
const show = (v, step) => (typeof v === 'string' ? v : v.toFixed(decimals(step)));
const line = ([title, items]) => `${title}: ` + items.map(([o, k, , , , st]) => `${k} ${show(o[k], st)}`).join(', ');
const button = (text, className = '') => Object.assign(document.createElement('button'), { type: 'button', textContent: text, className });

function copy(text, btn, out, label) {
  const fallback = () => { out.value = text; out.hidden = false; out.select(); out.scrollIntoView({ block: 'nearest' }); };
  try {
    navigator.clipboard.writeText(text).then(() => { btn.textContent = 'Copied'; setTimeout(() => { btn.textContent = label; }, 1200); }, fallback);
  } catch (err) { fallback(); }
}

// extra: sections not in spec now but swapped in later, so Reset covers them too.
export function createTuningPanel(el, spec, extra = [], heading = 'Tuning') {
  const sliders = []; // { obj, key, input, val, step } of the built panel, for refresh()
  const defaults = [...spec, ...extra].flatMap(([, items]) => items.map(([o, k]) => [o, k, o[k]]));

  function build() {
    el.innerHTML = '';
    const head = document.createElement('div');
    head.className = 'tune-head';
    const title = document.createElement('div');
    title.className = 'title';
    title.textContent = heading;
    const close = button('✕', 'tune-close');
    close.title = 'Close (T)';
    close.setAttribute('aria-label', 'Close');
    close.addEventListener('click', () => { el.hidden = true; });
    head.append(title, close);
    el.append(head);
    const out = document.createElement('textarea');
    out.readOnly = true;
    out.hidden = true;
    sliders.length = 0;
    for (const g of spec) {
      const [name, items] = g;
      const sec = document.createElement('details');
      sec.open = !closed.has(name);
      sec.addEventListener('toggle', () => { if (sec.open) closed.delete(name); else closed.add(name); saveClosed(); });
      const sum = document.createElement('summary');
      const h = document.createElement('h3');
      h.textContent = name;
      sum.append(h);
      const sc = button('Copy this section', 'sec-copy');
      sc.addEventListener('click', () => copy(line(g), sc, out, 'Copy this section'));
      sec.append(sum, sc);
      for (const [obj, key, label, min, max, step] of items) {
        const row = document.createElement('label');
        const text = document.createElement('span');
        text.textContent = label;
        const val = document.createElement('span');
        val.className = 'v';
        if (min === 'color') {
          val.textContent = obj[key];
          const pick = Object.assign(document.createElement('input'), { type: 'color', value: obj[key] });
          pick.addEventListener('input', () => { obj[key] = pick.value; val.textContent = pick.value; });
          pick.addEventListener('change', () => pick.blur());
          row.append(text, val, pick);
          sec.append(row);
          continue;
        }
        val.textContent = obj[key].toFixed(decimals(step));
        const input = Object.assign(document.createElement('input'), { type: 'range', min, max, step, value: obj[key] });
        input.addEventListener('input', () => {
          obj[key] = parseFloat(input.value);
          val.textContent = obj[key].toFixed(decimals(step));
        });
        // Hand the keyboard back to the game once the mouse lets go, so the camera keys work straight away.
        input.addEventListener('change', () => { if (!input.matches(':focus-visible')) input.blur(); });
        sliders.push({ obj, key, input, val, step });
        row.append(text, val, input);
        sec.append(row);
      }
      el.append(sec);
    }
    const buttons = document.createElement('div');
    buttons.className = 'tune-row';
    const all = button('Copy all values');
    const reset = button('Reset');
    all.addEventListener('click', () => copy(spec.map(line).join('\n'), all, out, 'Copy all values'));
    reset.addEventListener('click', () => { for (const [o, k, v] of defaults) o[k] = v; build(); });
    buttons.append(all, reset);
    el.append(buttons, out);
  }

  return {
    toggle() {
      el.hidden = !el.hidden;
      if (!el.hidden) build();
    },
    // Rebuild the open panel after spec changed (its sections swapped in place).
    rebuild() { if (!el.hidden) build(); },
    // Show values changed elsewhere (a key press) on the open panel's sliders.
    refresh() {
      for (const { obj, key, input, val, step } of sliders) {
        if (parseFloat(input.value) === obj[key]) continue;
        input.value = obj[key];
        val.textContent = obj[key].toFixed(decimals(step));
      }
    },
  };
}
