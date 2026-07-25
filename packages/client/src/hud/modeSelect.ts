/**
 * The mode picker.
 *
 * DOM rather than canvas, deliberately: it is a list of buttons shown while the
 * game is paused, and DOM gives real tap targets, scrolling, and text layout for
 * free. The canvas HUD earns its keep for things that track a moving thumb; this
 * is not one of them.
 *
 * Reads the registry, so a new mode appears here automatically.
 */

import { MODES, MODE_ORDER, type ModeId } from '@snow/shared';

export interface ModeSelectHandlers {
  onPick(id: ModeId, bots: number): void;
}

export class ModeSelect {
  private root: HTMLDivElement;
  private botCount = 5;

  constructor(
    parent: HTMLElement,
    private readonly handlers: ModeSelectHandlers,
  ) {
    this.root = document.createElement('div');
    this.root.className = 'mode-select';
    this.root.hidden = true;
    parent.appendChild(this.root);
    this.build();
  }

  show(): void {
    this.root.hidden = false;
  }

  hide(): void {
    this.root.hidden = true;
  }

  get visible(): boolean {
    return !this.root.hidden;
  }

  private build(): void {
    const card = document.createElement('div');
    card.className = 'mode-card';

    const h = document.createElement('h1');
    h.textContent = 'Snowball Fight';
    card.appendChild(h);

    const sub = document.createElement('p');
    sub.className = 'mode-sub';
    sub.textContent = 'Pick a mode. You and the bots share one device.';
    card.appendChild(sub);

    const list = document.createElement('div');
    list.className = 'mode-list';
    for (const id of MODE_ORDER) {
      const m = MODES[id];
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'mode-btn';
      // A stable handle for the automated tests. Targeting by label text or list
      // position breaks the moment a mode is renamed or reordered.
      btn.dataset['mode'] = id;

      const name = document.createElement('span');
      name.className = 'mode-name';
      name.textContent = m.label;
      btn.appendChild(name);

      const blurb = document.createElement('span');
      blurb.className = 'mode-blurb';
      blurb.textContent = m.blurb;
      btn.appendChild(blurb);

      btn.addEventListener('click', () => {
        // Practice has no opponents by design; everything else fills with bots.
        const bots = m.config.suggestedBots > 0 ? this.botCount : 0;
        this.hide();
        this.handlers.onPick(id, bots);
      });
      list.appendChild(btn);
    }
    card.appendChild(list);

    // Bot count. The one setting worth exposing, because it changes how a match
    // feels far more than anything else here.
    const row = document.createElement('label');
    row.className = 'mode-bots';
    const label = document.createElement('span');
    const update = (): void => {
      label.textContent = `Opponents: ${this.botCount}`;
    };
    const slider = document.createElement('input');
    slider.type = 'range';
    slider.min = '1';
    slider.max = '9';
    slider.step = '1';
    slider.value = String(this.botCount);
    slider.addEventListener('input', () => {
      this.botCount = parseInt(slider.value, 10);
      update();
    });
    update();
    row.appendChild(label);
    row.appendChild(slider);
    card.appendChild(row);

    this.root.appendChild(card);
  }
}
