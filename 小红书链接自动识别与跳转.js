// ==UserScript==
// @name         小红书链接自动识别与跳转
// @namespace    http://tampermonkey.net/
// @version      1.0.0
// @description  自动识别帖子和评论中的纯文本链接并转为可点击链接，在帖子弹窗中插入“传送”按钮快速打开当前笔记。
// @author       Codex
// @match        *://www.xiaohongshu.com/*
// @grant        none
// @run-at       document-end
// ==/UserScript==

(function () {
    'use strict';

    const MARK_ATTR = 'data-xhs-link-helper-processed';
    const BTN_ATTR = 'data-xhs-transport-btn';
    const STYLE_ID = 'xhs-link-helper-style';
    const LINK_CLASS = 'xhs-link-helper-anchor';

    const TARGET_SELECTORS = [
        '#detail-desc > .note-text > span',
        '.note-content .desc',
        '.note-container .content',
        '.comment-content'
    ];

    const DIALOG_SELECTORS = [
        '.note-container',
        '.post-modal',
        '.m-dialog',
        '.note-dialog'
    ].join(', ');

    const FOLLOW_BUTTON_TEXT = new Set(['关注', '已关注', '互相关注']);

    const GUIDE_PATTERNS = [
        /薯队长发布了一篇小红书笔记，快来看吧！/gi,
        /😆.*?😆/gi,
        /，复制本条信息，打开【小红书】App查看精彩内容！/gi,
        /复制这段内容后打开百度网盘手机App，操作更方便哦/gi,
        /【淘宝】/gi,
        /点击链接直接打开\s*或者\s*淘宝搜索直接打开/gi,
        /复制.*?打开.*?App/gi,
        /链接:\s*/gi
    ];

    const URL_REGEX = /((?:https?|ftp|file):\/\/[^\s<>"'`]+)/gi;
    const SKIP_TAGS = new Set(['A', 'BUTTON', 'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEXTAREA']);
    const processedTextNodes = new WeakSet();
    const queuedRoots = new Set();

    let flushScheduled = false;

    function injectStyle() {
        if (document.getElementById(STYLE_ID)) {
            return;
        }

        const style = document.createElement('style');
        style.id = STYLE_ID;
        style.textContent = `
            .${LINK_CLASS} {
                color: #12b76a;
                text-decoration: underline;
                word-break: break-all;
            }

            [${BTN_ATTR}="true"] {
                position: relative;
                display: inline-flex !important;
                align-items: center;
                justify-content: center;
                gap: 6px;
                min-width: 78px;
                padding: 0 18px !important;
                margin-right: 10px !important;
                border: 1px solid rgba(255, 36, 66, 0.18) !important;
                border-radius: 999px !important;
                background: linear-gradient(135deg, #fff8f8 0%, #ffeef2 100%) !important;
                color: #ff2442 !important;
                font-weight: 600 !important;
                letter-spacing: 0.02em;
                box-shadow: 0 6px 18px rgba(255, 36, 66, 0.12);
                transition:
                    transform 0.18s ease,
                    box-shadow 0.18s ease,
                    border-color 0.18s ease,
                    background 0.18s ease,
                    color 0.18s ease;
                overflow: hidden;
                isolation: isolate;
            }

            [${BTN_ATTR}="true"]::after {
                content: "";
                position: absolute;
                inset: 1px;
                border-radius: inherit;
                background: linear-gradient(180deg, rgba(255, 255, 255, 0.7), rgba(255, 255, 255, 0));
                z-index: -1;
                pointer-events: none;
            }

            [${BTN_ATTR}="true"]:hover {
                transform: translateY(-1px);
                border-color: rgba(255, 36, 66, 0.28) !important;
                box-shadow: 0 10px 24px rgba(255, 36, 66, 0.18);
                background: linear-gradient(135deg, #fff3f5 0%, #ffe7ec 100%) !important;
            }

            [${BTN_ATTR}="true"]:active {
                transform: translateY(0);
                box-shadow: 0 4px 10px rgba(255, 36, 66, 0.12);
            }

            [${BTN_ATTR}="true"]:focus-visible {
                outline: none;
                box-shadow:
                    0 0 0 3px rgba(255, 36, 66, 0.16),
                    0 10px 24px rgba(255, 36, 66, 0.18);
            }

            [${BTN_ATTR}="true"] span {
                color: inherit !important;
                font-weight: inherit !important;
            }

            @media (max-width: 768px) {
                [${BTN_ATTR}="true"] {
                    min-width: 72px;
                    padding: 0 16px !important;
                    margin-right: 8px !important;
                }
            }
        `;
        document.head.appendChild(style);
    }

    function cleanText(text) {
        let result = text;
        for (const pattern of GUIDE_PATTERNS) {
            result = result.replace(pattern, '');
        }
        return result;
    }

    function shouldSkipTextNode(node) {
        if (!node || processedTextNodes.has(node)) {
            return true;
        }

        const parent = node.parentElement;
        if (!parent) {
            return true;
        }

        if (SKIP_TAGS.has(parent.tagName)) {
            return true;
        }

        if (parent.closest(`a, button, [${BTN_ATTR}="true"]`)) {
            return true;
        }

        return false;
    }

    function buildFragmentFromText(text) {
        const cleanedText = cleanText(text);
        URL_REGEX.lastIndex = 0;
        const hasUrl = URL_REGEX.test(cleanedText);

        if (!hasUrl && cleanedText === text) {
            return null;
        }

        URL_REGEX.lastIndex = 0;

        const fragment = document.createDocumentFragment();
        let lastIndex = 0;
        let match;

        while (hasUrl && (match = URL_REGEX.exec(cleanedText)) !== null) {
            const [fullMatch] = match;
            const start = match.index;

            if (start > lastIndex) {
                fragment.appendChild(document.createTextNode(cleanedText.slice(lastIndex, start)));
            }

            const anchor = document.createElement('a');
            anchor.href = fullMatch;
            anchor.target = '_blank';
            anchor.rel = 'noopener noreferrer';
            anchor.className = LINK_CLASS;
            anchor.textContent = fullMatch;
            fragment.appendChild(anchor);

            lastIndex = start + fullMatch.length;
        }

        if (lastIndex < cleanedText.length) {
            fragment.appendChild(document.createTextNode(cleanedText.slice(lastIndex)));
        }

        return fragment;
    }

    function processTextNode(node) {
        if (shouldSkipTextNode(node)) {
            return;
        }

        const originalText = node.textContent;
        if (!originalText || !originalText.trim()) {
            processedTextNodes.add(node);
            return;
        }

        const fragment = buildFragmentFromText(originalText);
        if (!fragment) {
            processedTextNodes.add(node);
            return;
        }

        node.replaceWith(fragment);
        processedTextNodes.add(node);
    }

    function processContainer(container) {
        if (!(container instanceof HTMLElement)) {
            return;
        }

        const walker = document.createTreeWalker(
            container,
            NodeFilter.SHOW_TEXT,
            {
                acceptNode(node) {
                    return shouldSkipTextNode(node)
                        ? NodeFilter.FILTER_REJECT
                        : NodeFilter.FILTER_ACCEPT;
                }
            }
        );

        const textNodes = [];
        let current = walker.nextNode();

        while (current) {
            textNodes.push(current);
            current = walker.nextNode();
        }

        for (const textNode of textNodes) {
            processTextNode(textNode);
        }

        container.setAttribute(MARK_ATTR, 'true');
    }

    function getTargetContainers(root) {
        if (!(root instanceof Element || root instanceof Document)) {
            return [];
        }

        const containers = new Set();

        if (root instanceof Element) {
            for (const selector of TARGET_SELECTORS) {
                if (root.matches(selector)) {
                    containers.add(root);
                }
            }
        }

        for (const selector of TARGET_SELECTORS) {
            const matches = root.querySelectorAll(selector);
            for (const element of matches) {
                containers.add(element);
            }
        }

        return [...containers];
    }

    function normalizeButtonText(button, text) {
        const label = button.querySelector('span') || button;
        label.textContent = text;
    }

    function createTransportButton(followButton) {
        const button = followButton.cloneNode(true);
        button.setAttribute(BTN_ATTR, 'true');
        button.classList.add('xhs-transport-btn');
        button.removeAttribute('id');
        button.type = 'button';
        button.disabled = false;
        button.ariaDisabled = 'false';
        button.title = '打开当前笔记';
        button.setAttribute('aria-label', '打开当前笔记');
        normalizeButtonText(button, '直达');

        button.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();
            window.open(window.location.href, '_blank', 'noopener,noreferrer');
        });

        return button;
    }

    function isDialogFollowButton(button) {
        const text = button.textContent ? button.textContent.trim() : '';
        if (!FOLLOW_BUTTON_TEXT.has(text)) {
            return false;
        }

        return Boolean(button.closest(DIALOG_SELECTORS));
    }

    function ensureTransportButtons(root) {
        if (!(root instanceof Element || root instanceof Document)) {
            return;
        }

        const buttons = root.querySelectorAll('button');
        for (const followButton of buttons) {
            if (!isDialogFollowButton(followButton)) {
                continue;
            }

            const prev = followButton.previousElementSibling;
            if (prev?.getAttribute(BTN_ATTR) === 'true') {
                continue;
            }

            const transportButton = createTransportButton(followButton);
            followButton.parentNode?.insertBefore(transportButton, followButton);
        }
    }

    function processRoot(root) {
        const containers = getTargetContainers(root);
        for (const container of containers) {
            processContainer(container);
        }
        ensureTransportButtons(root);
    }

    function enqueueRoot(root) {
        if (!(root instanceof Element || root instanceof Document)) {
            return;
        }

        queuedRoots.add(root);
        if (flushScheduled) {
            return;
        }

        flushScheduled = true;
        requestAnimationFrame(() => {
            flushScheduled = false;
            const roots = [...queuedRoots];
            queuedRoots.clear();
            for (const queuedRoot of roots) {
                processRoot(queuedRoot);
            }
        });
    }

    function initObserver() {
        const observer = new MutationObserver((mutations) => {
            for (const mutation of mutations) {
                if (mutation.type !== 'childList' || mutation.addedNodes.length === 0) {
                    continue;
                }

                for (const node of mutation.addedNodes) {
                    if (node instanceof Element) {
                        enqueueRoot(node);
                    }
                }
            }
        });

        observer.observe(document.body, {
            childList: true,
            subtree: true
        });
    }

    function init() {
        injectStyle();
        processRoot(document);
        initObserver();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init, { once: true });
    } else {
        init();
    }
})();
