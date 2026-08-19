/* OCG PIPELINE — Piper Orbit behavior
   Presentation/state adapter only. Piper runtime, prompts, tools and persistence remain in app.js. */

(() => {
  function initOrbit() {
    const widget = document.getElementById('piper-widget');
    const drawer = document.getElementById('piper-drawer');
    const toggle = document.getElementById('piper-toggle');
    const collapse = document.getElementById('piper-collapse-btn');
    const expand = document.getElementById('piper-expand-btn');
    const input = document.getElementById('piper-chat-input');
    if (!widget || !drawer || !toggle) return;

    const setOpen = (open) => {
      drawer.classList.toggle('hidden', !open);
      widget.classList.toggle('summoned', open);
      toggle.setAttribute('aria-expanded', String(open));
      toggle.setAttribute('aria-label', open ? 'Hide Piper' : 'Call Piper');
      if (open) {
        window.setTimeout(() => input?.focus(), 220);
      }
    };

    // Orbit is the default every time the application boots.
    document.body.classList.remove('has-collapsed-piper', 'has-expanded-piper');
    widget.classList.remove('collapsed', 'expanded');
    setOpen(false);
    localStorage.setItem('piper_collapsed', 'true');
    localStorage.setItem('piper_expanded', 'false');

    // Use capture so the new interaction contract wins over legacy panel toggles.
    toggle.addEventListener('click', (event) => {
      event.stopImmediatePropagation();
      setOpen(drawer.classList.contains('hidden'));
    }, true);

    collapse?.addEventListener('click', (event) => {
      event.stopImmediatePropagation();
      widget.classList.remove('expanded');
      document.body.classList.remove('has-expanded-piper');
      setOpen(false);
      localStorage.setItem('piper_expanded', 'false');
    }, true);

    expand?.addEventListener('click', (event) => {
      event.stopImmediatePropagation();
      const next = !widget.classList.contains('expanded');
      widget.classList.toggle('expanded', next);
      document.body.classList.toggle('has-expanded-piper', next);
      setOpen(true);
      localStorage.setItem('piper_expanded', String(next));
    }, true);

    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && !drawer.classList.contains('hidden')) {
        if (widget.classList.contains('expanded')) {
          widget.classList.remove('expanded');
          document.body.classList.remove('has-expanded-piper');
          localStorage.setItem('piper_expanded', 'false');
        } else {
          setOpen(false);
        }
      }

      // Keyboard summon: Cmd/Ctrl + K mirrors an intelligence command palette.
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setOpen(true);
      }
    });

    // Clicking a workspace directive should not leave a large panel blocking the result.
    document.addEventListener('click', (event) => {
      const directiveAction = event.target.closest?.('[data-piper-directive], .quick-action-btn');
      if (directiveAction && window.innerWidth < 1024) {
        window.setTimeout(() => setOpen(false), 350);
      }
    });

    window.PiperOrbit = {
      summon() { setOpen(true); },
      dismiss() { setOpen(false); },
      expand() {
        widget.classList.add('expanded');
        document.body.classList.add('has-expanded-piper');
        setOpen(true);
      },
      collapse() {
        widget.classList.remove('expanded');
        document.body.classList.remove('has-expanded-piper');
        setOpen(false);
      }
    };
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => window.setTimeout(initOrbit, 0), { once: true });
  } else {
    window.setTimeout(initOrbit, 0);
  }
})();
