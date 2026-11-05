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
  const paidEnquiryType = 'Annual Employer Subscription Enquiry';

  const updateAnnualFields = () => {
    const paidOrder = enquiryType?.value === paidEnquiryType;
    if (annualFields) annualFields.hidden = !paidOrder;
    if (annualRequired) annualRequired.required = paidOrder;
  };

  enquiryType?.addEventListener('change', updateAnnualFields);
  updateAnnualFields();

  qsa('[data-enquiry-link]').forEach((link) => link.addEventListener('click', () => {
    if (!enquiryType) return;
    enquiryType.value = link.dataset.enquiryLink === 'order'
      ? paidEnquiryType
      : 'Free Founding Partner Trial';
    updateAnnualFields();
  }));

  const pricingApi = window.SparkFitPricing;
  const pricingCalculator = qs('[data-pricing-calculator]');
  const priceQuantity = qs('[data-price-quantity]');
  const seatSlider = qs('[data-seat-slider]');
  const priceBand = qs('[data-price-band]');
  const priceNote = qs('[data-price-note]');
  const priceOrder = qs('[data-price-order]');
  const calculatorError = qs('[data-calculator-error]');
  const provisionalNote = qs('[data-provisional-note]');
  const vatButtons = qsa('[data-vat-mode]');
  const packageCards = qsa('[data-package-seats]');
  const licenceQuantity = qs('[name="licenceQuantity"]');
  const requirements = qs('[name="requirements"]');
  const resultPanel = qs('.annual-plan-results');
  let vatMode = 'ex';
  let currentPlan = null;

  const setText = (selector, value, root = document) => {
    const node = qs(selector, root);
    if (node) node.textContent = value;
  };

  const updateVatControls = () => {
    vatButtons.forEach((button) => {
      const active = button.dataset.vatMode === vatMode;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-pressed', String(active));
    });
  };

  const renderPackages = () => {
    if (!pricingApi) return;
    packageCards.forEach((card) => {
      const seats = Number(card.dataset.packageSeats);
      const plan = pricingApi.calculateAnnualPlan(seats);
      const values = pricingApi.valuesForVatMode(plan, vatMode);
      setText('[data-package-discount]', `${plan.discountLabel} volume discount`, card);
      setText('[data-package-total]', pricingApi.formatPounds(values.employerTotal), card);
      setText('[data-package-vat]', `per year, ${values.vatLabel}`, card);
      setText('[data-package-monthly]', `${pricingApi.formatPounds(values.employerMonthlyTotal)} monthly equivalent`, card);
      setText('[data-package-saving]', `Save ${pricingApi.formatPounds(values.saving)} annually`, card);
      card.classList.toggle('is-selected', currentPlan?.seats === seats);
    });
  };

  const renderPlan = (plan) => {
    const values = pricingApi.valuesForVatMode(plan, vatMode);
    currentPlan = plan;
    if (priceQuantity) priceQuantity.setAttribute('aria-invalid', 'false');
    if (calculatorError) calculatorError.textContent = '';
    resultPanel?.classList.remove('is-invalid');
    if (priceOrder) {
      priceOrder.hidden = false;
      priceOrder.textContent = `Get Started with ${plan.seats.toLocaleString('en-GB')} Employees`;
    }
    if (priceBand) priceBand.textContent = `${plan.tierMinimum}-seat band · ${plan.discountLabel} volume discount`;
    if (provisionalNote) provisionalNote.hidden = !plan.provisional;
    setText('[data-result-seats]', plan.seats.toLocaleString('en-GB'));
    setText('[data-result-discount]', plan.discountLabel);
    setText('[data-direct-price]', pricingApi.formatPounds(values.directPerSeat));
    setText('[data-direct-price-label]', `Per employee, ${values.vatLabel}`);
    setText('[data-direct-total]', pricingApi.formatPounds(values.directTotal));
    setText('[data-direct-per-seat]', pricingApi.formatPounds(values.directPerSeat));
    setText('[data-direct-total-label]', `Direct individual purchasing, ${values.vatLabel}`);
    setText('[data-employer-total]', pricingApi.formatPounds(values.employerTotal));
    setText('[data-employer-total-label]', `Employer annual subscription, ${values.vatLabel}`);
    setText('[data-saving]', pricingApi.formatPounds(values.saving));
    setText('[data-saving-label]', `Annual saving, ${values.vatLabel}`);
    setText('[data-monthly-per-seat]', pricingApi.formatPounds(values.employerMonthlyPerSeat));
    setText('[data-monthly-total]', pricingApi.formatPounds(values.employerMonthlyTotal));
    if (priceNote) {
      const approval = plan.provisional ? ' This provisional 501 to 1,000 seat extension requires commercial approval.' : '';
      priceNote.textContent = `${plan.seats.toLocaleString('en-GB')} annual employee licences with a ${plan.discountLabel} volume discount. Prices are shown ${values.vatLabel}.${approval}`;
    }
    renderPackages();
  };

  const showInvalidQuantity = (quantity) => {
    currentPlan = null;
    if (priceQuantity) priceQuantity.setAttribute('aria-invalid', 'true');
    resultPanel?.classList.add('is-invalid');
    if (priceOrder) priceOrder.hidden = true;
    if (provisionalNote) provisionalNote.hidden = true;
    if (!calculatorError) return;
    if (!Number.isInteger(quantity)) calculatorError.textContent = 'Enter a whole number of employees.';
    else if (quantity < 20) calculatorError.textContent = 'The minimum annual subscription is 20 employee licences.';
    else if (quantity > 1000) calculatorError.textContent = 'For more than 1,000 employees, contact us for tailored enterprise pricing.';
    else calculatorError.textContent = 'Enter a whole number from 20 to 1,000.';
  };

  const updateCalculator = () => {
    if (!pricingApi || !pricingCalculator || !priceQuantity) return;
    const quantity = Number(priceQuantity.value);
    if (!pricingApi.validateSeats(quantity)) {
      showInvalidQuantity(quantity);
      return;
    }
    if (seatSlider) seatSlider.value = String(quantity);
    renderPlan(pricingApi.calculateAnnualPlan(quantity));
  };

  const applyCalculatorSelection = () => {
    if (!currentPlan || !enquiryType || !pricingApi) return;
    enquiryType.value = paidEnquiryType;
    updateAnnualFields();
    if (licenceQuantity) licenceQuantity.value = String(currentPlan.seats);
    if (requirements) {
      const summary = pricingApi.buildEnquirySummary(currentPlan, vatMode);
      const existingLines = requirements.value.split('\n').filter((line) => !line.startsWith('Pricing selection:') && !line.startsWith('Enterprise pricing request:'));
      requirements.value = [summary, ...existingLines].filter(Boolean).join('\n');
    }
  };

  priceQuantity?.addEventListener('input', updateCalculator);
  seatSlider?.addEventListener('input', () => {
    if (priceQuantity) priceQuantity.value = seatSlider.value;
    updateCalculator();
  });
  seatSlider?.addEventListener('keydown', (event) => {
    const keys = ['ArrowLeft', 'ArrowDown', 'ArrowRight', 'ArrowUp', 'Home', 'End'];
    if (!keys.includes(event.key)) return;
    event.preventDefault();
    const current = Number(seatSlider.value);
    const next = event.key === 'Home'
      ? 20
      : event.key === 'End'
        ? 1000
        : Math.min(1000, Math.max(20, current + (event.key === 'ArrowRight' || event.key === 'ArrowUp' ? 1 : -1)));
    seatSlider.value = String(next);
    if (priceQuantity) priceQuantity.value = String(next);
    updateCalculator();
  });
  packageCards.forEach((card) => card.addEventListener('click', () => {
    if (priceQuantity) priceQuantity.value = card.dataset.packageSeats;
    updateCalculator();
    pricingCalculator?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }));
  vatButtons.forEach((button) => button.addEventListener('click', () => {
    vatMode = button.dataset.vatMode === 'inc' ? 'inc' : 'ex';
    updateVatControls();
    if (currentPlan) renderPlan(currentPlan);
  }));
  priceOrder?.addEventListener('click', applyCalculatorSelection);
  qsa('[data-enterprise-link]').forEach((link) => link.addEventListener('click', () => {
    if (enquiryType) enquiryType.value = 'General Partnership Enquiry';
    updateAnnualFields();
    if (requirements) {
      const existingLines = requirements.value.split('\n').filter((line) => !line.startsWith('Enterprise pricing request:') && !line.startsWith('Pricing selection:'));
      requirements.value = ['Enterprise pricing request: More than 1,000 employee licences.', ...existingLines].filter(Boolean).join('\n');
    }
  }));
  updateVatControls();
  updateCalculator();

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
    video.autoplay = true;
    video.muted = true;
    video.defaultMuted = true;
    video.loop = true;
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
    video.play().catch(() => {
      // Browser autoplay policies may still require the visitor to press play.
    });
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

    const subject = `[SparkFit Partnerships] ${payload.enquiryType}: ${payload.organisation}`;
    const body = [
      'SparkFit partnership enquiry',
      '',
      `Enquiry type: ${payload.enquiryType}`,
      `Organisation: ${payload.organisation}`,
      `UK location: ${payload.ukLocation}`,
      `Contact name: ${payload.contactName}`,
      `Work email: ${payload.workEmail}`,
      `Approximate employee count: ${payload.employeeCount}`,
      `Desired annual licence quantity: ${payload.licenceQuantity || 'Not supplied / not applicable'}`,
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
