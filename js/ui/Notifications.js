/**
 * Lightweight toast notifications. Self-contained: creates its own container
 * and styles via CSS classes defined in styles.css.
 */
export class Notifications {
    container;
    constructor(containerId = 'toasts') {
        const existing = document.getElementById(containerId);
        if (existing) {
            this.container = existing;
        }
        else {
            this.container = document.createElement('div');
            this.container.id = containerId;
            this.container.className = 'toast-container';
            document.body.appendChild(this.container);
        }
    }
    show({ title, text = '', icon = '🔔', kind = 'info', duration = 4000 }) {
        const toast = document.createElement('div');
        toast.className = `toast toast-${kind}`;
        toast.innerHTML = `
      <div class="toast-icon">${icon}</div>
      <div class="toast-body">
        <div class="toast-title"></div>
        ${text ? '<div class="toast-text"></div>' : ''}
      </div>`;
        toast.querySelector('.toast-title').textContent = title;
        if (text)
            toast.querySelector('.toast-text').textContent = text;
        this.container.appendChild(toast);
        requestAnimationFrame(() => toast.classList.add('toast-show'));
        const remove = () => {
            toast.classList.remove('toast-show');
            toast.addEventListener('transitionend', () => toast.remove(), { once: true });
            setTimeout(() => toast.remove(), 400);
        };
        setTimeout(remove, duration);
        toast.addEventListener('click', remove);
    }
}
//# sourceMappingURL=Notifications.js.map