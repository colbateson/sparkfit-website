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
  const paidEnquiryType = 'Employee Access Code Order';

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

  const pricingCalculator = qs('[data-pricing-calculator]');
  const priceTerm = qs('[data-price-term]');
  const priceQuantity = qs('[data-price-quantity]');
  const priceBand = qs('[data-price-band]');
  const priceBase = qs('[data-price-base]');
  const pricePerCode = qs('[data-price-per-code]');
  const pricePerCodeLabel = qs('[data-price-per-code-label]');
  const priceTotal = qs('[data-price-total]');
  const priceTotalLabel = qs('[data-price-total-label]');
  const priceSaving = qs('[data-price-saving]');
  const priceSavingLabel = qs('[data-price-saving-label]');
  const priceNote = qs('[data-price-note]');
  const priceOrder = qs('[data-price-order]');
  const priceContact = qs('[data-price-contact]');
  const vatButtons = qsa('[data-vat-mode]');
  const tablePrices = qsa('[data-table-price]');
  const licenceQuantity = qs('[name="licenceQuantity"]');
  const requirements = qs('[name="requirements"]');

  const pricingTerms = {
    3: { label: '3 months', directGross: 14.97 },
    6: { label: '6 months', directGross: 29.94 },
    9: { label: '9 months', directGross: 44.91 },
    12: { label: '12 months', directGross: 24.99 },
    lifetime: { label: 'Lifetime', directGross: 59.99 }
  };

  const pricingTiers = [
    { minimum: 500, standard: 0.50, lifetime: 0.20, label: '500-code band' },
    { minimum: 250, standard: 0.40, lifetime: 0.15, label: '250-code band' },
    { minimum: 100, standard: 0.35, lifetime: 0.125, label: '100-code band' },
    { minimum: 75, standard: 0.30, lifetime: 0.10, label: '75-code band' },
    { minimum: 50, standard: 0.25, lifetime: 0.075, label: '50-code band' },
    { minimum: 20, standard: 0.20, lifetime: 0.05, label: '20-code band' }
  ];

  const formatCurrency = new Intl.NumberFormat('en-GB', {
    style: 'currency',
    currency: 'GBP',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });
  const roundMoney = (value) => Math.round((value + 0.00000001) * 100) / 100;
  const vatMultiplier = 1.20;
  let vatMode = 'ex';
  let currentPrice = null;

  const updateVatControls = () => {
    vatButtons.forEach((button) => {
      const active = button.dataset.vatMode === vatMode;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-pressed', String(active));
    });
    tablePrices.forEach((node) => {
      const value = Number.parseFloat(node.dataset[vatMode]);
      if (Number.isFinite(value)) node.textContent = formatCurrency.format(value);
    });
  };

  const updateCalculator = () => {
    if (!pricingCalculator || !priceTerm || !priceQuantity) return;
    const termKey = priceTerm.value;
    const term = pricingTerms[termKey];
    const quantity = Number.parseInt(priceQuantity.value, 10);
    currentPrice = null;
    if (priceBase) priceBase.textContent = term ? formatCurrency.format(term.directGross) : 'Not available';
    if (pricePerCodeLabel) pricePerCodeLabel.textContent = vatMode === 'inc' ? 'Employer price per code, inc VAT' : 'Employer price per code, ex VAT';
    if (priceTotalLabel) priceTotalLabel.textContent = vatMode === 'inc' ? 'Employer order total, inc VAT' : 'Employer order total, ex VAT';
    if (priceSavingLabel) priceSavingLabel.textContent = vatMode === 'inc' ? 'Reduction including VAT' : 'Reduction before VAT';

    if (!term || !Number.isInteger(quantity) || quantity < 20) {
      if (priceBand) priceBand.textContent = 'Minimum order: 20 codes';
      if (pricePerCode) pricePerCode.textContent = 'Not available';
      if (priceTotal) priceTotal.textContent = 'Enter 20+';
      if (priceSaving) priceSaving.textContent = 'Not available';
      if (priceNote) priceNote.textContent = 'Enter at least 20 employee codes to calculate an employer price.';
      if (priceOrder) priceOrder.hidden = true;
      if (priceContact) priceContact.hidden = true;
      return;
    }

    if (quantity > 500) {
      currentPrice = { termKey, term, quantity, bespoke: true };
      if (priceBand) priceBand.textContent = '501+ codes · bespoke volume pricing';
      if (pricePerCode) pricePerCode.textContent = 'Custom quote';
      if (priceTotal) priceTotal.textContent = 'Contact us';
      if (priceSaving) priceSaving.textContent = 'Volume pricing';
      if (priceNote) priceNote.textContent = `${term.label} of Premium access for ${quantity.toLocaleString('en-GB')} employees requires a tailored quotation.`;
      if (priceOrder) priceOrder.hidden = true;
      if (priceContact) priceContact.hidden = false;
      return;
    }

    const tier = pricingTiers.find((candidate) => quantity >= candidate.minimum);
    const discount = termKey === 'lifetime' ? tier.lifetime : tier.standard;
    const referenceExVat = roundMoney(term.directGross / vatMultiplier);
    const perCodeExVat = roundMoney(referenceExVat * (1 - discount));
    const perCodeIncVat = roundMoney(perCodeExVat * vatMultiplier);
    const perCode = vatMode === 'inc' ? perCodeIncVat : perCodeExVat;
    const totalExVat = roundMoney(perCodeExVat * quantity);
    const totalIncVat = roundMoney(perCodeIncVat * quantity);
    const total = vatMode === 'inc' ? totalIncVat : totalExVat;
    const referenceTotal = roundMoney((vatMode === 'inc' ? term.directGross : referenceExVat) * quantity);
    const saving = roundMoney(referenceTotal - total);
    currentPrice = { termKey, term, tier, quantity, discount, perCode, perCodeExVat, perCodeIncVat, total, totalExVat, totalIncVat, saving, vatMode, bespoke: false };

    if (priceBand) priceBand.textContent = `${tier.label} · ${discount * 100}% volume discount`;
    if (pricePerCode) pricePerCode.textContent = formatCurrency.format(perCode);
    if (priceTotal) priceTotal.textContent = formatCurrency.format(total);
    if (priceSaving) priceSaving.textContent = formatCurrency.format(saving);
    if (priceNote) {
      const vatView = vatMode === 'inc' ? 'including VAT at 20%' : 'excluding VAT';
      priceNote.textContent = termKey === 'lifetime'
        ? `Lifetime Premium access for ${quantity.toLocaleString('en-GB')} employees. The direct app-store price is ${formatCurrency.format(term.directGross)} including VAT. Employer prices are shown ${vatView}.`
        : `${term.label} of Premium access for ${quantity.toLocaleString('en-GB')} employees. The direct app-store comparison is ${formatCurrency.format(term.directGross)} including VAT. Employer prices are shown ${vatView}.`;
    }
    if (priceOrder) priceOrder.hidden = false;
    if (priceContact) priceContact.hidden = true;
  };

  const applyCalculatorSelection = () => {
    if (!currentPrice || !enquiryType) return;
    enquiryType.value = paidEnquiryType;
    updateAnnualFields();
    if (licenceQuantity) licenceQuantity.value = String(currentPrice.quantity);

    const summary = currentPrice.bespoke
      ? `Pricing selection: ${currentPrice.term.label}, ${currentPrice.quantity} codes, bespoke quote required.`
      : `Pricing selection: ${currentPrice.term.label}, ${currentPrice.quantity} codes, ${formatCurrency.format(currentPrice.perCodeExVat)} per code excluding VAT, ${formatCurrency.format(currentPrice.perCodeIncVat)} per code including VAT, ${formatCurrency.format(currentPrice.totalExVat)} guide total excluding VAT, ${formatCurrency.format(currentPrice.totalIncVat)} guide total including VAT, ${currentPrice.discount * 100}% volume discount applied.`;

    if (requirements) {
      const existingLines = requirements.value.split('\n').filter((line) => !line.startsWith('Pricing selection:'));
      requirements.value = [summary, ...existingLines].filter(Boolean).join('\n');
    }
  };

  priceTerm?.addEventListener('change', updateCalculator);
  priceQuantity?.addEventListener('input', updateCalculator);
  vatButtons.forEach((button) => button.addEventListener('click', () => {
    vatMode = button.dataset.vatMode === 'inc' ? 'inc' : 'ex';
    updateVatControls();
    updateCalculator();
  }));
  priceOrder?.addEventListener('click', applyCalculatorSelection);
  priceContact?.addEventListener('click', applyCalculatorSelection);
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
      `Desired code quantity: ${payload.licenceQuantity || 'Not supplied / not applicable'}`,
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
