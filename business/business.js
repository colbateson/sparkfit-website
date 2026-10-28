(() => {
  'use strict';

  const qs = (selector, root = document) => root.querySelector(selector);
  const qsa = (selector, root = document) => [...root.querySelectorAll(selector)];

  const header = qs('[data-header]');
  const navToggle = qs('[data-nav-toggle]');
  const nav = qs('[data-nav]');

  const updateHeader = () => header?.classList.toggle('is-sticky', window.scrollY > 34);
  updateHeader();
  window.addEventListener('scroll', updateHeader, { passive: true });

  navToggle?.addEventListener('click', () => {
    const open = navToggle.getAttribute('aria-expanded') === 'true';
    navToggle.setAttribute('aria-expanded', String(!open));
    nav?.classList.toggle('is-open', !open);
  });

  qsa('[data-nav] a').forEach((link) => link.addEventListener('click', () => {
    navToggle?.setAttribute('aria-expanded', 'false');
    nav?.classList.remove('is-open');
  }));

  qsa('[data-year]').forEach((node) => { node.textContent = String(new Date().getFullYear()); });

  const enquiryType = qs('[data-enquiry-type]');
  const annualFields = qs('[data-annual-fields]');
  const annualRequired = qs('[data-annual-required]');

  const updateAnnualFields = () => {
    const annual = enquiryType?.value === 'Annual Employee Wellbeing Partnership';
    if (annualFields) annualFields.hidden = !annual;
    if (annualRequired) annualRequired.required = annual;
  };

  enquiryType?.addEventListener('change', updateAnnualFields);
  updateAnnualFields();

  qsa('[data-enquiry-link]').forEach((link) => link.addEventListener('click', () => {
    if (!enquiryType) return;
    enquiryType.value = link.dataset.enquiryLink === 'annual'
      ? 'Annual Employee Wellbeing Partnership'
      : 'Free Founding Partner Trial';
    updateAnnualFields();
  }));

  const carousel = qs('[data-carousel]');
  const cards = qsa('[data-carousel-card]');
  const scrollCarousel = (direction) => {
    if (!carousel || cards.length === 0) return;
    const cardWidth = cards[0].getBoundingClientRect().width;
    carousel.scrollBy({ left: direction * (cardWidth + 22), behavior: 'smooth' });
  };
  qs('[data-carousel-prev]')?.addEventListener('click', () => scrollCarousel(-1));
  qs('[data-carousel-next]')?.addEventListener('click', () => scrollCarousel(1));
  carousel?.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowLeft') { event.preventDefault(); scrollCarousel(-1); }
    if (event.key === 'ArrowRight') { event.preventDefault(); scrollCarousel(1); }
  });

  const lightbox = qs('[data-lightbox]');
  const lightboxImage = qs('[data-lightbox-image]');
  const lightboxClose = qs('[data-lightbox-close]');

  qsa('[data-lightbox-src]').forEach((button) => button.addEventListener('click', () => {
    if (!lightbox || !lightboxImage) return;
    lightboxImage.src = button.dataset.lightboxSrc || '';
    lightboxImage.alt = button.dataset.lightboxAlt || 'Expanded SparkFit screenshot';
    if (typeof lightbox.showModal === 'function') lightbox.showModal();
  }));

  lightboxClose?.addEventListener('click', () => lightbox?.close());
  lightbox?.addEventListener('click', (event) => {
    const box = lightbox.getBoundingClientRect();
    const outside = event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom;
    if (outside) lightbox.close();
  });

  const videoComponent = qs('[data-video-component]');
  let videoChecked = false;

  const sourceExists = async (url) => {
    try {
      const response = await fetch(url, { method: 'HEAD', cache: 'no-store' });
      return response.ok;
    } catch (_) {
      return false;
    }
  };

  const activateVideo = async () => {
    if (!videoComponent || videoChecked) return;
    videoChecked = true;
    const candidates = [
      { src: videoComponent.dataset.webm, type: 'video/webm' },
      { src: videoComponent.dataset.mp4, type: 'video/mp4' }
    ].filter((source) => source.src);
    const available = [];
    for (const candidate of candidates) {
      if (await sourceExists(candidate.src)) available.push(candidate);
    }
    if (available.length === 0) return;

    const video = document.createElement('video');
    video.controls = true;
    video.playsInline = true;
    video.preload = 'metadata';
    video.poster = videoComponent.dataset.poster || '';
    video.setAttribute('aria-label', 'SparkFit for Business promotional video');
    available.forEach(({ src, type }) => {
      const source = document.createElement('source');
      source.src = src;
      source.type = type;
      video.append(source);
    });
    videoComponent.replaceChildren(video);
  };

  if (videoComponent) {
    if ('IntersectionObserver' in window) {
      const observer = new IntersectionObserver((entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          observer.disconnect();
          activateVideo();
        }
      }, { rootMargin: '250px' });
      observer.observe(videoComponent);
    } else {
      activateVideo();
    }
  }

  const form = qs('[data-business-form]');
  const submitButton = qs('[data-form-submit]');
  const formStatus = qs('[data-form-status]');

  form?.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!form.reportValidity()) return;

    const originalText = submitButton?.textContent || 'Send partnership enquiry';
    if (submitButton) {
      submitButton.disabled = true;
      submitButton.textContent = 'Sending…';
    }
    if (formStatus) {
      formStatus.textContent = '';
      formStatus.className = 'form-status';
    }

    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 15000);
    const payload = Object.fromEntries(new FormData(form).entries());

    try {
      const response = await fetch(form.action, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify(payload),
        credentials: 'same-origin',
        signal: controller.signal
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.message || 'We could not send the enquiry.');

      form.reset();
      updateAnnualFields();
      if (formStatus) {
        formStatus.textContent = 'Thank you. Your enquiry has been sent to SparkFit Partnerships.';
        formStatus.classList.add('is-success');
      }
    } catch (error) {
      if (formStatus) {
        formStatus.innerHTML = 'We could not send this securely right now. Please email <a href="mailto:partnerships@spark-fit.com">partnerships@spark-fit.com</a>.';
        formStatus.classList.add('is-error');
      }
    } finally {
      window.clearTimeout(timeout);
      if (submitButton) {
        submitButton.disabled = false;
        submitButton.textContent = originalText;
      }
    }
  });
})();
