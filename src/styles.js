const CSS = `
.dsh-manager-card { list-style: none; border: 1px solid var(--dsw-alias-border-l2); border-radius: 12px; background: var(--dsw-alias-bg-layer-3); transition: border-color .16s, background .16s; }
.dsh-manager-card:hover { border-color: var(--dsw-alias-label-dimmed); }
.dsh-manager-card-open { background: var(--dsw-alias-bg-layer-2); border-color: var(--dsw-alias-label-dimmed); }
.dsh-manager-card-header { width: 100%; appearance: none; border: 0; background: none; font: inherit; color: inherit; text-align: left; cursor: pointer; display: flex; align-items: center; gap: 12px; padding: 14px 16px; border-radius: 12px; }
.dsh-manager-card-header:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: -2px; }
.dsh-manager-card-head-text { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 4px; }
.dsh-manager-card-name { font-size: 15px; font-weight: 600; line-height: 1.4; color: var(--dsw-alias-label-primary); }
.dsh-manager-card-description { font-size: 13px; line-height: 1.5; color: var(--dsw-alias-label-tertiary); }
.dsh-manager-card-chevron { flex: none; color: var(--dsw-alias-label-tertiary); transition: transform .16s; }
.dsh-manager-card-chevron-open { transform: rotate(180deg); }
.dsh-manager-card-pending { flex: none; border-radius: 999px; padding: 1px 8px; font-size: 11px; line-height: 17px; font-weight: 500; white-space: nowrap; background: var(--dsw-alias-bg-module-platform); color: var(--dsw-alias-label-secondary); }
.dsh-manager-card-body { border-top: 1px solid var(--dsw-alias-border-l2); margin: 0 16px; padding: 12px 0 8px; }
.dsh-manager-field { display: flex; flex-direction: column; gap: 4px; min-width: 0; margin: 10px 0; }
.dsh-manager-field-label { font-size: 12px; line-height: 16px; color: var(--dsw-alias-label-secondary); }
.dsh-manager-input { width: 100%; box-sizing: border-box; min-height: 32px; padding: 4px 8px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 8px; background: var(--dsw-alias-bg-layer-3); color: var(--dsw-alias-label-primary); font-size: 13px; line-height: 20px; }
.dsh-manager-input:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: -1px; }
.dsh-manager-checkbox { width: 16px; height: 16px; accent-color: var(--dsw-alias-brand-primary); }
.dsh-manager-field-inline { flex-direction: row; align-items: center; gap: 8px; }
.dsh-manager-card-failed { margin: 0 0 10px; font-size: 12px; line-height: 1.5; color: var(--dsw-alias-label-error); }
.dsh-manager-card-footer { display: flex; align-items: center; justify-content: flex-end; gap: 8px; padding: 12px 0 4px; border-top: 1px solid var(--dsw-alias-border-l2); }
.dsh-manager-card-discard, .dsh-manager-card-save { appearance: none; border: 1px solid transparent; border-radius: 8px; padding: 5px 14px; font: inherit; font-size: 13px; line-height: 1.5; cursor: pointer; }
.dsh-manager-card-discard { border-color: var(--dsw-alias-border-l2); background: none; color: var(--dsw-alias-label-secondary); }
.dsh-manager-card-discard:hover:not(:disabled) { color: var(--dsw-alias-label-primary); border-color: var(--dsw-alias-label-dimmed); }
.dsh-manager-card-save { background: var(--dsw-alias-label-primary); color: var(--dsw-alias-bg-layer-3); }
.dsh-manager-card-save:disabled, .dsh-manager-card-discard:disabled { opacity: .4; cursor: default; }
.dsh-manager-card-save:focus-visible, .dsh-manager-card-discard:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }
`;

export function adoptStyles() {
  if (typeof document === "undefined") return;
  const id = "@nevermindzzt/dsh-manager-plugin/settings-card";
  if (document.querySelector('style[data-plugin-css="' + id + '"]')) return;
  const style = document.createElement("style");
  style.dataset.plugin = "@nevermindzzt/dsh-manager-plugin";
  style.dataset.pluginCss = id;
  style.textContent = CSS;
  document.head.appendChild(style);
}
