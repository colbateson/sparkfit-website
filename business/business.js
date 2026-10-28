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
  const formStatus = qs('[data-form-status]');

  form?.addEventListener('submit', (event) => {
    event.preventDefault();
    if (!form.reportValidity()) return;

    if (formStatus) {
      formStatus.textContent = '';
      formStatus.className = 'form-status';
    }

    const payload = Object.fromEntries(new FormData(form).entries());

    const subject = `[SparkFit Partnerships] ${payload.enquiryType} — ${payload.organisation}`;
    const body = [
      'SparkFit partnership enquiry',
      '',
      `Enquiry type: ${payload.enquiryType}`,
      `Organisation: ${payload.organisation}`,
      `UK location: ${payload.ukLocation}`,
      `Contact name: ${payload.contactName}`,
      `Work email: ${payload.workEmail}`,
      `Approximate employee count: ${payload.employeeCount}`,
      `Desired licence quantity: ${payload.licenceQuantity || 'Not supplied / not applicable'}`,
      `Intended launch timeframe: ${payload.launchTimeframe}`,
      '',
      'Additional requirements:',
      payload.requirements || 'None supplied'
    ].join('\n');

    if (formStatus) {
      formStatus.textContent = 'Your email app should open with the enquiry ready to send.';
      formStatus.classList.add('is-success');
    }

    window.location.href = `mailto:partnerships@spark-fit.com?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  });
})();
