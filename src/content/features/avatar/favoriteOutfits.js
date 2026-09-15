import { observeElement } from '../../core/observer.js';
import { settings } from '../../core/settings/getSettings.js';
import { addTooltip } from '../../core/ui/tooltip.js';
import { ts } from '../../core/locale/i18n.js';

const SETTING_NAME = 'favoriteOutfitsEnabled';
const STORAGE_KEY = 'rovalra_favorite_outfits';

const CARD_SELECTOR = 'li.list-item';
const CARD_CLASS = 'rovalra-outfit-card';
const THUMB_CLASS = 'rovalra-outfit-thumb';
const BUTTON_CLASS = 'rovalra-favorite-outfit-btn';
const ICON_CLASS = 'icon-favorite';
const FAVORITED_CLASS = 'favorited';
const ID_DATASET_KEY = 'rovalraOutfitId';
const ORDER_DATASET_KEY = 'rovalraOutfitOrder';

let enabled = false;
let favorites = new Set();
let observersRegistered = false;
let storageListenerRegistered = false;

const pendingLists = new Set();
let reorderFrame = null;
const naturalOrderCounters = new WeakMap();

function loadFavorites() {
    return new Promise((resolve) => {
        chrome.storage.local.get({ [STORAGE_KEY]: [] }, (data) => {
            const stored = data?.[STORAGE_KEY];
            resolve(new Set(Array.isArray(stored) ? stored.map(String) : []));
        });
    });
}

function saveFavorites() {
    return new Promise((resolve) => {
        chrome.storage.local.set({ [STORAGE_KEY]: [...favorites] }, resolve);
    });
}

function isOnCreationsTab() {
    if (window.location.hash.toLowerCase().includes('creations')) return true;

    const breadcrumb = document.querySelector('.breadcrumb-container');
    return Boolean(breadcrumb) && /creations/i.test(breadcrumb.textContent || '');
}

function getCardName(card) {
    const nameEl = card.querySelector(
        '[data-item-name], .avatar-name, .item-card-name',
    );
    return (nameEl?.dataset?.itemName || nameEl?.textContent || '').trim();
}

function getOutfitId(card) {
    if (!isOnCreationsTab()) return null;
    if (card.querySelector('a[href*="/catalog/"], a[href*="/library/"]'))
        return null;
    if (card.querySelector('[class*="robux" i]')) return null;

    const thumb = card.querySelector('[data-thumbnail-target-id]');
    const thumbId = thumb?.getAttribute('data-thumbnail-target-id');
    if (thumbId) return `t:${thumbId}`;

    const name = getCardName(card);
    return name ? `n:${name.toLowerCase()}` : null;
}

function assignNaturalOrder(card, list) {
    if (card.dataset[ORDER_DATASET_KEY] !== undefined) return;
    const next = (naturalOrderCounters.get(list) || 0) + 1;
    naturalOrderCounters.set(list, next);
    card.dataset[ORDER_DATASET_KEY] = String(next);
}

function updateButton(button, id) {
    const favorited = favorites.has(id);
    button.querySelector(`.${ICON_CLASS}`)?.classList.toggle(FAVORITED_CLASS, favorited);
    button.setAttribute('aria-pressed', String(favorited));
}

function updateCard(card, id) {
    const button = card.querySelector(`.${BUTTON_CLASS}`);
    if (button) updateButton(button, id);
}

// Batches reordering per parent list to one write per frame, no matter how
// many cards change at once.
function scheduleReorder(list) {
    if (!list) return;
    pendingLists.add(list);
    if (reorderFrame) return;

    reorderFrame = requestAnimationFrame(() => {
        reorderFrame = null;
        const lists = [...pendingLists];
        pendingLists.clear();
        lists.forEach(reorderList);
    });
}

function reorderList(list) {
    if (!list?.isConnected) return;

    const cards = [...list.children];
    const allRecognised = cards.every(
        (card) => card.matches?.(CARD_SELECTOR) && card.dataset[ID_DATASET_KEY],
    );
    if (cards.length < 2 || !allRecognised) return;

    const sorted = [...cards].sort(
        (a, b) =>
            Number(a.dataset[ORDER_DATASET_KEY]) -
            Number(b.dataset[ORDER_DATASET_KEY]),
    );
    const favorited = sorted.filter((card) =>
        favorites.has(card.dataset[ID_DATASET_KEY]),
    );
    const rest = sorted.filter(
        (card) => !favorites.has(card.dataset[ID_DATASET_KEY]),
    );

    for (const card of [...favorited, ...rest]) list.appendChild(card);
}

async function toggleFavorite(card, id) {
    if (favorites.has(id)) favorites.delete(id);
    else favorites.add(id);

    await saveFavorites();
    updateCard(card, id);
    scheduleReorder(card.parentElement);
}

function getThumbContainer(card) {
    const tagged = card.querySelector('[data-thumbnail-target-id]');
    if (tagged && tagged.tagName !== 'IMG') return tagged;

    const img = card.querySelector('img');
    if (!img) return card;

    return img.parentElement && img.parentElement !== card
        ? img.parentElement
        : card;
}

function ensureButton(card, id) {
    if (card.querySelector(`.${BUTTON_CLASS}`)) return;

    card.classList.add(CARD_CLASS);
    const thumb = getThumbContainer(card);
    thumb.classList.add(THUMB_CLASS);

    const button = document.createElement('button');
    button.type = 'button';
    button.className = BUTTON_CLASS;

    const icon = document.createElement('span');
    icon.className = ICON_CLASS;
    button.append(icon);

    button.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        toggleFavorite(card, card.dataset[ID_DATASET_KEY]);
    });

    addTooltip(button, () =>
        ts(
            favorites.has(card.dataset[ID_DATASET_KEY])
                ? 'avatar.favoriteOutfits.unfavorite'
                : 'avatar.favoriteOutfits.favorite',
        ),
    );

    thumb.append(button);
    updateButton(button, id);
}

function attachCard(card) {
    if (!enabled) return;

    const id = getOutfitId(card);
    if (!id) return;

    card.dataset[ID_DATASET_KEY] = id;
    assignNaturalOrder(card, card.parentElement);
    ensureButton(card, id);
    updateCard(card, id);
    scheduleReorder(card.parentElement);
}

function removeUi() {
    document.querySelectorAll(`.${BUTTON_CLASS}`).forEach((button) => button.remove());
    document.querySelectorAll(`.${THUMB_CLASS}`).forEach((thumb) => thumb.classList.remove(THUMB_CLASS));
    document.querySelectorAll(`.${CARD_CLASS}`).forEach((card) => {
        card.classList.remove(CARD_CLASS);
        delete card.dataset[ID_DATASET_KEY];
        delete card.dataset[ORDER_DATASET_KEY];
    });
}

function refreshAllCards() {
    document.querySelectorAll(`.${CARD_CLASS}`).forEach((card) => {
        const id = card.dataset[ID_DATASET_KEY];
        if (!id) return;
        updateCard(card, id);
        scheduleReorder(card.parentElement);
    });
}

function registerObservers() {
    if (observersRegistered) return;
    observersRegistered = true;

    observeElement(CARD_SELECTOR, attachCard, { multiple: true });
}

function registerStorageListener() {
    if (storageListenerRegistered) return;
    storageListenerRegistered = true;

    chrome.storage.onChanged.addListener(async (changes, namespace) => {
        if (namespace !== 'local') return;

        if (changes[STORAGE_KEY]) {
            const stored = changes[STORAGE_KEY].newValue;
            favorites = new Set(Array.isArray(stored) ? stored.map(String) : []);
            if (enabled) refreshAllCards();
        }

        if (!changes[SETTING_NAME]) return;

        enabled = changes[SETTING_NAME].newValue === true;
        if (!enabled) {
            removeUi();
            return;
        }

        favorites = await loadFavorites();
        registerObservers();
    });
}

export async function init() {
    if (!window.location.pathname.includes('/my/avatar')) return;

    registerStorageListener();

    enabled = (await settings[SETTING_NAME]) === true;
    if (!enabled) return;

    favorites = await loadFavorites();
    registerObservers();
}
