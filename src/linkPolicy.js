'use strict';

function cleanLink(value) {
  return String(value || '').trim().replace(/[),.;!?\]}]+$/u, '');
}

function extractExternalLinks(content) {
  const value = String(content || '');
  const matches = value.match(/(?:https?:\/\/|www\.)[^\s<>()]+|(?:discord\.gg|discord(?:app)?\.com\/invite)\/[^\s<>()]+/giu) || [];
  return matches.map(cleanLink).filter(Boolean);
}

function parseUrl(value) {
  let url = cleanLink(value);
  if (/^www\./i.test(url)) url = `https://${url}`;
  else if (/^(?:discord\.gg|discord(?:app)?\.com\/invite)\//i.test(url)) url = `https://${url}`;
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

function isGifLink(value) {
  const parsed = parseUrl(value);
  if (!parsed) return false;
  const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
  const path = parsed.pathname.toLowerCase();

  // Direct GIF media from any host is treated as media, not a normal external link.
  if (/\.gif$/i.test(path)) return true;

  // Discord-uploaded GIFs and GIF picker media.
  if ((host === 'cdn.discordapp.com' || host === 'media.discordapp.net') && /\/attachments\//i.test(path)) {
    return /\.gif$/i.test(path);
  }

  // Tenor pages commonly use /view/...-gif-<id> without a .gif extension.
  if (host === 'tenor.com' || host.endsWith('.tenor.com')) {
    return host === 'media.tenor.com' || path.startsWith('/view/') || /(?:^|[-_/])gif(?:[-_/]|$)/i.test(path);
  }

  // GIPHY share pages and direct media.
  if (host === 'giphy.com' || host.endsWith('.giphy.com')) {
    return host === 'media.giphy.com' || path.startsWith('/gifs/') || path.startsWith('/media/');
  }

  return false;
}

function isGifOnlyExternalLinks(content) {
  const links = extractExternalLinks(content);
  return links.length > 0 && links.every(isGifLink);
}

module.exports = {
  extractExternalLinks,
  isGifLink,
  isGifOnlyExternalLinks,
};
