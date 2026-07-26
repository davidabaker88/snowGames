/**
 * The lobby: host a room, or join one by code.
 *
 * DOM rather than canvas, for the same reason the mode picker is: it is text entry and
 * buttons on a paused screen, which the platform already does well. A four-character
 * code field on a phone in particular wants a real input -- autocapitalise off,
 * autocorrect off, and the right keyboard.
 *
 * The flow deliberately puts the room code in front of the player as large as it will
 * go. That code is read aloud across a room, so legibility is the feature.
 */

import { ROOM_CODE_LENGTH, isValidRoomCode, normalizeRoomCode } from '@snow/shared';
import type { RoomStatus } from '../net/room.js';

export interface LobbyHandlers {
  onHost(): void;
  onJoin(code: string): void;
  onCancel(): void;
  /** Host only: everybody is in, start playing. */
  onStart(): void;
  /** Show a code for somebody to scan. Needs no server. */
  onHostQr(): void;
  /** Scan somebody's code. Needs no server. */
  onJoinQr(): void;
}

export class Lobby {
  private root: HTMLDivElement;
  private card: HTMLDivElement;
  private handlers: LobbyHandlers;

  constructor(parent: HTMLElement, handlers: LobbyHandlers) {
    this.handlers = handlers;
    this.root = document.createElement('div');
    this.root.className = 'lobby';
    this.root.hidden = true;
    this.card = document.createElement('div');
    this.card.className = 'lobby-card';
    this.root.appendChild(this.card);
    parent.appendChild(this.root);
    this.showChoice();
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

  /** The opening screen: host, or join. */
  showChoice(): void {
    this.card.replaceChildren();
    this.card.appendChild(h1('Play together'));
    this.card.appendChild(
      sub('One phone hosts the match. Everyone else joins with the code it shows you.'),
    );

    const hostBtn = button('Host a game', 'lobby-primary');
    hostBtn.addEventListener('click', () => this.handlers.onHost());
    this.card.appendChild(hostBtn);

    this.card.appendChild(divider('or'));

    // A form, so the on-screen keyboard shows a "go" key and Enter submits.
    const form = document.createElement('form');
    form.className = 'lobby-join';

    const input = document.createElement('input');
    input.className = 'lobby-code-input';
    input.type = 'text';
    input.inputMode = 'text';
    input.autocapitalize = 'characters';
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.maxLength = 8;
    input.placeholder = 'CODE';
    input.setAttribute('aria-label', 'Room code');

    const joinBtn = button('Join', 'lobby-secondary');
    // A stable handle. Three buttons on this screen share `.lobby-secondary` because they
    // share a look, so class is not an identity -- `data-action` is.
    joinBtn.dataset['action'] = 'join-code';
    joinBtn.type = 'submit';
    joinBtn.disabled = true;

    // Normalise as they type, so the field always shows exactly what will be sent.
    // Nothing is guessed at -- see `normalizeRoomCode` for why a misread is better
    // rejected than silently redirected into somebody else's match.
    input.addEventListener('input', () => {
      const cleaned = normalizeRoomCode(input.value);
      if (cleaned !== input.value) input.value = cleaned;
      joinBtn.disabled = !isValidRoomCode(cleaned);
    });

    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const code = normalizeRoomCode(input.value);
      if (isValidRoomCode(code)) this.handlers.onJoin(code);
    });

    form.appendChild(input);
    form.appendChild(joinBtn);
    this.card.appendChild(form);

    this.card.appendChild(divider('no internet needed'));

    // The QR path. Listed second because typing four characters is less faff per player
    // than two scans -- but it is the one that needs nothing set up at all, which is why
    // it says so on the button.
    const qrRow = document.createElement('div');
    qrRow.className = 'lobby-qr-row';
    const hostQr = button('Show a code', 'lobby-secondary');
    hostQr.dataset['action'] = 'host-qr';
    hostQr.addEventListener('click', () => this.handlers.onHostQr());
    const joinQr = button('Scan a code', 'lobby-secondary');
    joinQr.dataset['action'] = 'join-qr';
    joinQr.addEventListener('click', () => this.handlers.onJoinQr());
    qrRow.appendChild(hostQr);
    qrRow.appendChild(joinQr);
    this.card.appendChild(qrRow);

    const back = button('Play on this device instead', 'lobby-quiet');
    back.addEventListener('click', () => this.handlers.onCancel());
    this.card.appendChild(back);
  }

  /**
   * Show a code, with an instruction and an optional next step.
   *
   * The instruction is a full sentence rather than a label, because a person holding up a
   * phone with a QR code on it needs to be told what happens next -- "Invite" on its own
   * leaves both people waiting for the other one to do something.
   */
  showQr(opts: {
    title: string;
    instruction: string;
    canvas: HTMLCanvasElement;
    next?: { label: string; onClick(): void };
    note?: string;
  }): void {
    this.card.replaceChildren();
    this.card.appendChild(h1(opts.title));
    this.card.appendChild(sub(opts.instruction));

    const holder = document.createElement('div');
    holder.className = 'qr-holder';
    holder.appendChild(opts.canvas);
    this.card.appendChild(holder);

    if (opts.note) this.card.appendChild(sub(opts.note));
    if (opts.next) {
      const b = button(opts.next.label, 'lobby-primary');
      b.dataset['action'] = 'qr-next';
      b.addEventListener('click', opts.next.onClick);
      this.card.appendChild(b);
    }
    const cancel = button('Cancel', 'lobby-quiet');
    cancel.addEventListener('click', () => this.handlers.onCancel());
    this.card.appendChild(cancel);
  }

  /** Show the camera, pointed at somebody else's screen. */
  showScanner(opts: { title: string; instruction: string; video: HTMLVideoElement }): void {
    this.card.replaceChildren();
    this.card.appendChild(h1(opts.title));
    this.card.appendChild(sub(opts.instruction));

    const holder = document.createElement('div');
    holder.className = 'qr-holder qr-holder-video';
    holder.appendChild(opts.video);
    // A frame to aim with. Without it people hold the phone too far back and the code
    // never fills enough of the sensor to resolve.
    const reticle = document.createElement('div');
    reticle.className = 'qr-reticle';
    holder.appendChild(reticle);
    this.card.appendChild(holder);

    const cancel = button('Cancel', 'lobby-quiet');
    cancel.addEventListener('click', () => this.handlers.onCancel());
    this.card.appendChild(cancel);
  }

  /**
   * Host side, after a QR join succeeds.
   *
   * A separate screen from `showHosting` because there is no room code in this path, and
   * `showHosting` exists to display one -- passing it an empty string produced a heading
   * that read "Your room code" above nothing.
   */
  showQrHostConnected(
    peers: number,
    roster: string[],
    actions: { onAnother(): void; onStart(): void },
  ): void {
    this.card.replaceChildren();
    this.card.appendChild(h1(peers === 1 ? '1 player connected' : `${peers} players connected`));
    this.card.appendChild(
      sub('Add another by showing a new code, or start the match now.'),
    );

    if (roster.length > 0) {
      const list = document.createElement('ul');
      list.className = 'lobby-roster';
      for (const name of roster) {
        const li = document.createElement('li');
        li.textContent = name;
        list.appendChild(li);
      }
      this.card.appendChild(list);
    }

    const start = button('Start the match', 'lobby-primary');
    start.dataset['action'] = 'qr-start';
    start.addEventListener('click', actions.onStart);
    this.card.appendChild(start);

    const another = button('Add another player', 'lobby-secondary');
    another.dataset['action'] = 'qr-another';
    another.addEventListener('click', actions.onAnother);
    this.card.appendChild(another);

    const cancel = button('Close', 'lobby-quiet');
    cancel.addEventListener('click', () => this.handlers.onCancel());
    this.card.appendChild(cancel);
  }

  /** Report progress, or the room code once we have one. */
  setStatus(status: RoomStatus, roster: string[] = []): void {
    switch (status.kind) {
      case 'creating':
        this.showWaiting('Opening a room…');
        return;
      case 'joining':
        this.showWaiting(`${status.step}…`);
        return;
      case 'hosting':
        this.showHosting(status.code, status.peers, roster);
        return;
      case 'failed':
        this.showFailed(status.reason);
        return;
      case 'joined':
      case 'idle':
        return;
    }
  }

  private showWaiting(text: string): void {
    this.card.replaceChildren();
    this.card.appendChild(h1('Just a moment'));
    this.card.appendChild(sub(text));
    const cancel = button('Cancel', 'lobby-quiet');
    cancel.addEventListener('click', () => this.handlers.onCancel());
    this.card.appendChild(cancel);
  }

  private showHosting(code: string, peers: number, roster: string[]): void {
    this.card.replaceChildren();
    this.card.appendChild(h1('Your room code'));

    // The code, as big as it will go. It gets read across a room.
    const codeEl = document.createElement('div');
    codeEl.className = 'lobby-code';
    // Spaced characters, so nobody reads two of them as one.
    codeEl.textContent = code.split('').join(' ');
    codeEl.setAttribute('aria-label', `Room code ${code.split('').join(' ')}`);
    this.card.appendChild(codeEl);

    this.card.appendChild(
      sub(
        peers === 0
          ? 'Waiting for players. They open the same page and tap Join.'
          : `${peers} connected. Start whenever you are ready.`,
      ),
    );

    if (roster.length > 0) {
      const list = document.createElement('ul');
      list.className = 'lobby-roster';
      for (const name of roster) {
        const li = document.createElement('li');
        li.textContent = name;
        list.appendChild(li);
      }
      this.card.appendChild(list);
    }

    const start = button(peers === 0 ? 'Start with bots' : 'Start the match', 'lobby-primary');
    start.addEventListener('click', () => this.handlers.onStart());
    this.card.appendChild(start);

    const cancel = button('Close the room', 'lobby-quiet');
    cancel.addEventListener('click', () => this.handlers.onCancel());
    this.card.appendChild(cancel);
  }

  private showFailed(reason: string): void {
    this.card.replaceChildren();
    this.card.appendChild(h1('That did not work'));
    // The reason verbatim: the four ways a join fails need four different responses
    // from the player, and a generic "connection error" tells them none of them.
    this.card.appendChild(sub(reason));
    const again = button('Try again', 'lobby-primary');
    again.addEventListener('click', () => this.showChoice());
    this.card.appendChild(again);
    const back = button('Play on this device instead', 'lobby-quiet');
    back.addEventListener('click', () => this.handlers.onCancel());
    this.card.appendChild(back);
  }
}

// ---------------------------------------------------------------------------

function h1(text: string): HTMLElement {
  const el = document.createElement('h1');
  el.textContent = text;
  return el;
}

function sub(text: string): HTMLElement {
  const el = document.createElement('p');
  el.className = 'lobby-sub';
  el.textContent = text;
  return el;
}

function button(text: string, cls: string): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = cls;
  b.textContent = text;
  return b;
}

function divider(text: string): HTMLElement {
  const el = document.createElement('div');
  el.className = 'lobby-divider';
  el.textContent = text;
  return el;
}

export { ROOM_CODE_LENGTH };
