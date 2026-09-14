import { observeElement } from '../../core/observer.js';
import { settings } from '../../core/settings/getSettings.js';
import { Icon, ChangeIcon } from '../../core/ui/buildericon.js';
import { addTooltip } from '../../core/ui/tooltip.js';
import { ts } from '../../core/locale/i18n.js';

const SETTING_NAME = 'favoriteOutfitsEnabled';
const STORAGE_KEY = 'rovalra_favorite_outfits';

const CARD_SELECTOR = 'li.list-item';
const CARD_CLASS = 'rovalra-outfit-card';
const BUTTON_CLASS = 'rovalra-favorite-outfit-btn';
const FAVORITED_CLASS = 'rovalra-favorited-outfit';
const ID_DATASET_KEY = 'rovalraOutfitId';

let enabled = false;
let favorites = new Set();
let observersRegistered = false;
let storageListenerRegistered = false;

const pendingLists = new Set();
let reorderFrame = null;

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

// Every tab on this page reuses the same list-item markup, but only saved
// outfits carry a thumbnail id without also linking out to the catalog.
function getOutfitId(card) {
    if (card.querySelector('a[href*="/catalog/"], a[href*="/library/"]'))
        return null;

    const thumb = card.querySelector('[data-thumbnail-target-id]');
    return thumb?.getAttribute('data-thumbnail-target-id') || null;
}

function updateButton(button, id) {
    const favorited = favorites.has(id);
    ChangeIcon(button.querySelector('icon'), { icon: 'star', filled: favorited });
    button.classList.toggle(FAVORITED_CLASS, favorited);
    button.setAttribute('aria-pressed', String(favorited));
}

function updateCard(card, id) {
    card.classList.toggle(FAVORITED_CLASS, favorites.has(id));
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

// Only reorders once every child is a recognised outfit tile, so a list that
// mixes in something this feature does not understand is left alone.
function reorderList(list) {
    if (!list?.isConnected) return;

    const cards = [...list.children];
    const allRecognised = cards.every(
        (card) => card.matches?.(CARD_SELECTOR) && card.dataset[ID_DATASET_KEY],
    );
    if (cards.length < 2 || !allRecognised) return;

    const favorited = [];
    const rest = [];
    for (const card of cards) {
        (favorites.has(card.dataset[ID_DATASET_KEY]) ? favorited : rest).push(
            card,
        );
    }
    if (!favorited.length) return;

    for (const card of [...favorited, ...rest]) list.appendChild(card);
}

async function toggleFavorite(card, id) {
    if (favorites.has(id)) favorites.delete(id);
    else favorites.add(id);

    await saveFavorites();
    updateCard(card, id);
    scheduleReorder(card.parentElement);
}

function ensureButton(card, id) {
    if (card.querySelector(`.${BUTTON_CLASS}`)) return;

    card.classList.add(CARD_CLASS);

    const button = document.createElement('button');
    button.type = 'button';
    button.className = BUTTON_CLASS;
    button.append(Icon({ icon: 'star', material: true, size: 'small' }));

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

    card.prepend(button);
    updateButton(button, id);
}

function attachCard(card) {
    if (!enabled) return;

    const id = getOutfitId(card);
    if (!id) return;

    card.dataset[ID_DATASET_KEY] = id;
    ensureButton(card, id);
    updateCard(card, id);
    scheduleReorder(card.parentElement);
}

function removeUi() {
    document.querySelectorAll(`.${BUTTON_CLASS}`).forEach((button) => button.remove());
    document.querySelectorAll(`.${CARD_CLASS}`).forEach((card) => {
        card.classList.remove(CARD_CLASS, FAVORITED_CLASS);
        delete card.dataset[ID_DATASET_KEY];
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
