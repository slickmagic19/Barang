// Repo wiki viewer: a themed modal that lists the generated pages and renders
// their markdown. Generation itself lives in lib/repoWiki (planning + hidden
// model sessions); this module only reads disk state and shows progress.
import { el, md, timeAgo } from '../lib/util';
import { iconEl } from './icons';
import { confirmDialog } from './dialog';
import { agentStore, syncRepoWiki } from '../lib/agent';
import {
  WIKI_DIR, readWiki, wikiStore,
  type WikiManifest,
} from '../lib/repoWiki';

export interface WikiHooks {
  toast(msg: string, kind?: 'info' | 'error'): void;
}

/** Open the repo wiki viewer (single instance). */
export function openWiki(hooks: WikiHooks) {
  if (document.querySelector('.wiki-overlay')) return;

  const state: {
    manifest: WikiManifest | null;
    pages: Record<string, string>;
    active: string;
  } = { manifest: null, pages: {}, active: '' };

  const overlay = el('div', { class: 'wiki-overlay' });
  const modal = el('div', { class: 'wiki-modal', role: 'dialog', 'aria-label': 'Repo wiki' });

  const head = el('div', { class: 'wiki-head' });
  const title = el('div', { class: 'wiki-title' });
  title.append(iconEl('book', 16), el('span', {}, 'Repo Wiki'));
  const status = el('div', { class: 'wiki-status' });
  head.append(title, status);

  const actions = el('div', { class: 'wiki-actions' });
  const btnUpdate = el('button', { class: 'btn btn-sm', title: 'Generate missing pages / refresh changed files' }, 'Update') as HTMLButtonElement;
  const btnRebuild = el('button', { class: 'btn btn-sm', title: 'Regenerate every page' }, 'Rebuild') as HTMLButtonElement;
  const btnClose = el('button', { class: 'icon-btn', title: 'Close (Esc)' }) as HTMLButtonElement;
  btnClose.append(iconEl('x', 15));
  actions.append(btnUpdate, btnRebuild, btnClose);
  head.append(actions);

  const progressWrap = el('div', { class: 'wiki-progress hidden' });
  const progressFill = el('div', { class: 'wiki-progress-fill' });
  progressWrap.append(progressFill);

  const main = el('div', { class: 'wiki-main' });
  const nav = el('div', { class: 'wiki-nav' });
  const content = el('div', { class: 'wiki-content' });
  const article = el('article', { class: 'md-preview wiki-article' });
  content.append(article);
  main.append(nav, content);

  const foot = el('div', { class: 'wiki-foot' });
  foot.append(el('span', {}, `Pages live in ${WIKI_DIR}/pages — automatic updates follow Settings › Repo wiki.`));

  modal.append(head, progressWrap, main, foot);
  overlay.append(modal);
  document.body.append(overlay);

  let lastLoadedAt = -1;

  const busy = () => {
    const s = wikiStore.get().status;
    return s === 'planning' || s === 'generating';
  };

  const paintStatus = () => {
    const st = wikiStore.get();
    const b = busy();
    btnUpdate.disabled = b;
    btnRebuild.disabled = b;
    progressWrap.classList.toggle('hidden', !b);
    if (b && st.total > 0) {
      progressFill.style.width = `${Math.round((st.done / st.total) * 100)}%`;
    } else {
      progressFill.style.width = '0%';
    }
    if (b || st.error) {
      status.textContent = st.message || st.error || '';
      status.classList.toggle('is-error', !!st.error && !b);
      return;
    }
    if (st.message && st.status === 'done') {
      status.textContent = st.message;
      status.classList.remove('is-error');
      return;
    }
    const m = state.manifest;
    if (m?.pages.length) {
      const when = m.generatedAt ? ` · ${timeAgo(m.generatedAt)}` : '';
      status.textContent = `${m.pages.length} page${m.pages.length === 1 ? '' : 's'}${m.complete ? '' : ' (incomplete)'}${when}`;
    } else {
      status.textContent = 'Not generated yet';
    }
    status.classList.remove('is-error');
  };

  const paint = () => {
    paintStatus();
    nav.innerHTML = '';
    const pages = state.manifest?.pages ?? [];
    if (!state.active && pages.length) state.active = pages[0].slug;

    if (!pages.length) {
      article.innerHTML = '';
      content.querySelector('.wiki-empty')?.remove();
      const empty = el('div', { class: 'wiki-empty' });
      const hasRoot = !!agentStore.get().root;
      empty.append(el('div', { class: 'wiki-empty-title' }, hasRoot ? 'No repo wiki yet' : 'No project open'));
      empty.append(el('div', { class: 'wiki-empty-sub' },
        hasRoot
          ? 'Barang can document this project automatically — overview, architecture, tech stack, conventions, and one page per module.'
          : 'Open a folder first, then generate its wiki.'));
      if (hasRoot) {
        const gen = el('button', { class: 'btn btn-primary btn-sm' }, 'Generate wiki') as HTMLButtonElement;
        gen.disabled = busy();
        gen.onclick = () => void syncRepoWiki('manual');
        empty.append(gen);
      }
      content.append(empty);
      return;
    }
    content.querySelector('.wiki-empty')?.remove();

    for (const page of pages) {
      const item = el('button', {
        class: `wiki-nav-item${page.slug === state.active ? ' active' : ''}`,
        title: page.title,
      });
      const label = el('span', { class: 'wiki-nav-title' }, page.title);
      const kind = el('span', { class: `wiki-kind is-${page.kind}` }, page.kind);
      item.append(label, kind);
      item.onclick = () => {
        state.active = page.slug;
        paint();
      };
      nav.append(item);
    }

    const page = pages.find((p) => p.slug === state.active) ?? pages[0];
    const body = page ? state.pages[page.slug] : '';
    if (page && body) {
      article.innerHTML = md(body);
    } else if (page) {
      article.innerHTML = '';
      article.append(el('div', { class: 'wiki-empty-sub' }, 'This page has not been generated yet. Use Update.'));
    }
    content.scrollTop = 0;
    const activeItem = nav.querySelector('.wiki-nav-item.active');
    activeItem?.scrollIntoView({ block: 'nearest' });
  };

  async function reload() {
    const r = await readWiki();
    if (!document.contains(overlay)) return;
    state.manifest = r.manifest ?? wikiStore.get().manifest;
    state.pages = r.pages;
    if (state.manifest && !state.manifest.pages.some((p) => p.slug === state.active)) {
      state.active = state.manifest.pages[0]?.slug ?? '';
    }
    paint();
  }

  const unsub = wikiStore.subscribe(() => {
    const st = wikiStore.get();
    if (st.status === 'done' && st.manifest && st.manifest.generatedAt !== lastLoadedAt) {
      lastLoadedAt = st.manifest.generatedAt;
      void reload();
      return;
    }
    if (st.manifest && !state.manifest) {
      state.manifest = st.manifest;
      paint();
      return;
    }
    paintStatus();
  });

  const close = () => {
    unsub();
    document.removeEventListener('keydown', onKey, true);
    overlay.remove();
  };
  const onKey = (e: KeyboardEvent) => {
    // A themed confirm dialog stacks above the viewer and owns Escape.
    if (document.querySelector('.confirm-overlay')) return;
    if (e.key === 'Escape' && document.contains(overlay)) {
      e.preventDefault();
      e.stopPropagation();
      close();
    }
  };
  document.addEventListener('keydown', onKey, true);
  btnClose.onclick = close;
  overlay.addEventListener('mousedown', (e) => {
    if (e.target === overlay) close();
  });

  btnUpdate.onclick = () => {
    void syncRepoWiki('manual').catch((e: unknown) => hooks.toast(String((e as Error)?.message ?? e), 'error'));
  };
  btnRebuild.onclick = () => {
    const count = state.manifest?.pages.length ?? 0;
    void confirmDialog({
      title: 'Rebuild the repo wiki?',
      message: count
        ? `Regenerates all ${count} page${count === 1 ? '' : 's'} with the model. This can take a few minutes and uses tokens.`
        : 'Generates every page with the model. This can take a few minutes and uses tokens.',
      confirmLabel: 'Rebuild',
      danger: false,
    }).then((okd) => {
      if (okd) void syncRepoWiki('manual', { force: true });
    });
  };

  article.append(el('div', { class: 'wiki-empty-sub' }, 'Loading wiki…'));
  paintStatus();
  void reload();
}
