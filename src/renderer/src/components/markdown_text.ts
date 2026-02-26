import { marked } from 'marked';

export class MarkdownText extends HTMLElement {
  private _text: string = '';
  private _dialog: HTMLDialogElement | null = null;
  private _lightboxImg: HTMLImageElement | null = null;
  private _zoom = 1;
  private _panX = 0;
  private _panY = 0;
  private _dragging = false;
  private _dragStartX = 0;
  private _dragStartY = 0;
  private _panStartX = 0;
  private _panStartY = 0;

  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this.closeLightbox = this.closeLightbox.bind(this);
    this.resetZoom = this.resetZoom.bind(this);
    this.handleDialogClick = this.handleDialogClick.bind(this);
    this.handleDialogCancel = this.handleDialogCancel.bind(this);
    this.handleDblClick = this.handleDblClick.bind(this);
    this.handleWheel = this.handleWheel.bind(this);
    this.handleMouseDown = this.handleMouseDown.bind(this);
    this.handleLightboxMouseMove = this.handleLightboxMouseMove.bind(this);
    this.handleLightboxMouseUp = this.handleLightboxMouseUp.bind(this);
    this.handleClick = this.handleClick.bind(this);
    this.handleKeyDown = this.handleKeyDown.bind(this);
  }

  static get observedAttributes() {
    return ['text'];
  }

  attributeChangedCallback(name: string, _oldValue: string, newValue: string) {
    if (name === 'text') {
      this.text = newValue;
    }
  }

  set text(val: string) {
    this._text = val || '';
    this.render();
  }

  get text() {
    return this._text;
  }

  connectedCallback() {
    this.render();
    this.addEventListeners();
  }

  disconnectedCallback() {
    this.removeEventListeners();
    this.removeDialog();
  }

  private ensureDialog() {
    if (this._dialog) return;
    if (!this.shadowRoot) return;

    this._dialog = document.createElement('dialog');
    this._dialog.className = 'lightbox';
    this._lightboxImg = document.createElement('img');
    this._dialog.appendChild(this._lightboxImg);

    this._dialog.addEventListener('click', this.handleDialogClick);
    this._dialog.addEventListener('cancel', this.handleDialogCancel);
    this._dialog.addEventListener('dblclick', this.handleDblClick);
    this._dialog.addEventListener('wheel', this.handleWheel, { passive: false });
    this._dialog.addEventListener('mousedown', this.handleMouseDown);

    this.shadowRoot.appendChild(this._dialog);
  }

  private removeDialog() {
    if (!this._dialog) return;
    this._dialog.removeEventListener('click', this.handleDialogClick);
    this._dialog.removeEventListener('cancel', this.handleDialogCancel);
    this._dialog.removeEventListener('dblclick', this.handleDblClick);
    this._dialog.removeEventListener('wheel', this.handleWheel);
    this._dialog.removeEventListener('mousedown', this.handleMouseDown);
    document.removeEventListener('mousemove', this.handleLightboxMouseMove);
    document.removeEventListener('mouseup', this.handleLightboxMouseUp);
    this._dialog.remove();
    this._dialog = null;
    this._lightboxImg = null;
  }

  private openLightbox(src: string) {
    this.ensureDialog();
    if (!this._dialog || !this._lightboxImg) return;
    this._lightboxImg.src = src;
    this._zoom = 1;
    this._panX = 0;
    this._panY = 0;
    this.applyTransform();
    this._dialog.showModal();
    this._dialog.style.cursor = 'default';
  }

  private closeLightbox() {
    if (!this._dialog) return;
    this._dialog.close();
    this._dragging = false;
    document.removeEventListener('mousemove', this.handleLightboxMouseMove);
    document.removeEventListener('mouseup', this.handleLightboxMouseUp);
    this.removeDialog();
  }

  private applyTransform() {
    if (!this._lightboxImg) return;
    if (this._zoom === 1 && this._panX === 0 && this._panY === 0) {
      this._lightboxImg.style.transform = 'none';
    } else {
      this._lightboxImg.style.transform = `translate(${this._panX}px, ${this._panY}px) scale(${this._zoom})`;
    }
  }

  private resetZoom() {
    this._zoom = 1;
    this._panX = 0;
    this._panY = 0;
    this.applyTransform();
    if (this._dialog) this._dialog.style.cursor = 'default';
  }

  private handleDialogClick(e: MouseEvent) {
    if (e.target === this._dialog && this._zoom === 1) {
      this.closeLightbox();
    }
  }

  private handleDialogCancel(e: Event) {
    e.preventDefault();
    this.closeLightbox();
  }

  private handleDblClick(e: MouseEvent) {
    if (e.target === this._lightboxImg) {
      if (this._zoom !== 1) {
        this.resetZoom();
      } else {
        const rect = this._lightboxImg!.getBoundingClientRect();
        const ucx = (rect.left + rect.right) / 2;
        const ucy = (rect.top + rect.bottom) / 2;
        this._panX = -(e.clientX - ucx);
        this._panY = -(e.clientY - ucy);
        this._zoom = 2;
        this.applyTransform();
        if (this._dialog) this._dialog.style.cursor = 'grab';
      }
    }
  }

  private handleWheel(e: WheelEvent) {
    e.preventDefault();
    if (!this._lightboxImg) return;

    const factor = e.deltaY > 0 ? 0.95 : 1.05;
    const newZoom = Math.min(Math.max(this._zoom * factor, 0.5), 10);
    const ratio = newZoom / this._zoom;

    const rect = this._lightboxImg.getBoundingClientRect();
    const ucx = (rect.left + rect.right) / 2 - this._panX;
    const ucy = (rect.top + rect.bottom) / 2 - this._panY;
    this._panX = (e.clientX - ucx) * (1 - ratio) + this._panX * ratio;
    this._panY = (e.clientY - ucy) * (1 - ratio) + this._panY * ratio;

    this._zoom = newZoom;

    if (this._zoom <= 1.01) {
      this.resetZoom();
    } else {
      this.applyTransform();
      if (this._dialog) this._dialog.style.cursor = 'grab';
    }
  }

  private handleMouseDown(e: MouseEvent) {
    if (this._zoom <= 1 || e.target !== this._lightboxImg) return;
    e.preventDefault();
    this._dragging = true;
    this._dragStartX = e.clientX;
    this._dragStartY = e.clientY;
    this._panStartX = this._panX;
    this._panStartY = this._panY;
    if (this._dialog) this._dialog.style.cursor = 'grabbing';
    document.addEventListener('mousemove', this.handleLightboxMouseMove);
    document.addEventListener('mouseup', this.handleLightboxMouseUp);
  }

  private handleLightboxMouseMove(e: MouseEvent) {
    if (!this._dragging) return;
    this._panX = this._panStartX + (e.clientX - this._dragStartX);
    this._panY = this._panStartY + (e.clientY - this._dragStartY);
    this.applyTransform();
  }

  private handleLightboxMouseUp() {
    this._dragging = false;
    if (this._dialog) this._dialog.style.cursor = 'grab';
    document.removeEventListener('mousemove', this.handleLightboxMouseMove);
    document.removeEventListener('mouseup', this.handleLightboxMouseUp);
  }

  private render() {
    if (!this.shadowRoot) return;

    const renderer = new marked.Renderer();
    const originalImage = renderer.image.bind(renderer);

    const getVideoType = (href: string): string => {
      const ext = href.toLowerCase().split('.').pop();
      if (ext === 'mov') return 'mp4';
      if (ext === 'mkv') return 'x-matroska';
      return ext || 'mp4';
    };

    renderer.image = (href: string, title: string | null, text: string): string => {
      const videoExtensions = ['.mp4', '.webm', '.ogg', '.mov', '.mkv'];
      const urlWithoutFragment = href.split('#')[0].split('?')[0];
      const isVideo = videoExtensions.some(ext => urlWithoutFragment.toLowerCase().endsWith(ext));

      if (isVideo) {
        const titleAttr = title ? ` title="${title}"` : '';
        return `<video controls preload="auto"${titleAttr} tabindex="0">
  <source src="${href}" type="video/${getVideoType(urlWithoutFragment)}">
  ${text}
</video>`;
      }

      return originalImage(href, title, text);
    };

    const html = marked(this._text, { renderer });

    this.shadowRoot.innerHTML = `
      <style>
        :host {
          display: block;
        }
        .content img, .content video {
          max-width: 100%;
          height: auto;
          display: block;
          margin: 10px 0;
          border-radius: 4px;
        }
        .content img {
          cursor: pointer;
        }
        .content video {
          background-color: #000;
        }
        .content video:focus {
          outline: 2px solid var(--color-focus-border, #4b9cf5);
          outline-offset: 2px;
        }
        dialog.lightbox {
          border: none;
          padding: 0;
          margin: 0;
          max-width: 100vw;
          max-height: 100vh;
          width: 100vw;
          height: 100vh;
          background: transparent;
          overflow: hidden;
          outline: none;
        }
        dialog.lightbox[open] {
          display: flex;
          justify-content: center;
          align-items: center;
        }
        dialog.lightbox::backdrop {
          background: rgba(0, 0, 0, 0.9);
        }
        dialog.lightbox img {
          max-width: 95vw;
          max-height: 95vh;
          object-fit: contain;
          user-select: none;
          -webkit-user-drag: none;
        }
      </style>
      <div class="content">${html}</div>
    `;
  }

  private addEventListeners() {
    this.shadowRoot?.addEventListener('keydown', this.handleKeyDown as EventListener, true);
    this.shadowRoot?.addEventListener('click', this.handleClick as EventListener);
  }

  private removeEventListeners() {
    this.shadowRoot?.removeEventListener('keydown', this.handleKeyDown as EventListener, true);
    this.shadowRoot?.removeEventListener('click', this.handleClick as EventListener);
  }

  private handleClick(e: MouseEvent) {
    const target = e.target as HTMLElement;
    if (target instanceof HTMLImageElement && target.closest('.content')) {
      e.preventDefault();
      this.openLightbox(target.src);
    }
  }

  private handleKeyDown(e: KeyboardEvent) {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    const target = e.target;
    if (target instanceof HTMLVideoElement) {
      e.preventDefault();
      e.stopImmediatePropagation();
      const delta = e.key === 'ArrowLeft' ? -5 : 5;
      target.currentTime = Math.max(0, Math.min(target.duration, target.currentTime + delta));
    }
  }
}
