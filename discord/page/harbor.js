/*
 * Harbor's Discord tools: everything an agent can do in Discord, as code that runs inside the
 * Discord page. The host (discord/main.js, or any other engine) only injects this file and calls
 * `$harbor.call(name, args)`, so the tools don't depend on Electron.
 *
 * Ported from discord-mcp-bridge (its discordMcp plugin and server.ts), which is
 * GPL-3.0-or-later like this file.
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * NEEDS names every internal of Discord's the tools use; the self-test checks them all without
 * sending anything. When Discord changes one, repair edits this file in a local override.
 */
(() => {
"use strict";

const sleep = ms => new Promise(r => setTimeout(r, ms));
const Web = () => window.Vencord?.Webpack;

/* -------------------------------------------------------------- Discord's internals -- */

/** How to find each internal. `props`: any one of these property sets. `optional`: tools still
 * work without it. `source`: a string that must be in Discord's bundle (an id or class name the
 * tools look for in the page). `lazy`: Discord only loads it with the chat view, so it can't be
 * judged before a channel has been open. */
const NEEDS = {
    SelectedChannelStore: { props: [["getChannelId", "getVoiceChannelId"]] },
    ChannelStore: { props: [["getChannel", "hasChannel"]] },
    GuildStore: { props: [["getGuild", "getGuilds"]] },
    UserStore: { props: [["getCurrentUser", "getUser"]] },
    MessageStore: { props: [["getMessage", "getMessages"]] },
    MessageActions: { props: [["sendMessage", "editMessage"]] },
    ChannelActions: { props: [["selectChannel", "selectVoiceChannel"]] },
    // selectChannel only moves a store; these change what's on the page, as the sidebar does.
    ChannelRouter: { find: W => (W.Common?.ChannelRouter?.transitionToChannel ? W.Common.ChannelRouter : undefined) },
    NavigationRouter: { find: W => (W.Common?.NavigationRouter?.transitionTo ? W.Common.NavigationRouter : undefined) },
    RelationshipStore: { props: [["getRelationshipType", "isFriend"]] },
    PresenceStore: { props: [["getStatus", "getActivities"], ["getStatus", "isMobileOnline"]], optional: true },
    TypingStore: { props: [["getTypingUsers", "isTyping"]], optional: true },
    TypingActions: { props: [["startTyping", "stopTyping"]], optional: true, lazy: true },
    PrivateChannelSortStore: { props: [["getPrivateChannelIds"], ["getSortedPrivateChannels"]] },
    ReadStateStore: { props: [["getUnreadCount", "getMentionCount"], ["hasUnread", "getUnreadCount"]] },
    GuildChannelStore: { props: [["getChannels", "getDefaultChannel"], ["getChannels"]] },
    EmojiStore: { props: [["getGuilds", "getDisambiguatedEmojiContext"], ["getCustomEmojiById", "getUsableCustomEmoji"], ["getGuildEmoji"]] },
    SortedGuildStore: { props: [["getGuildFolders"]] },
    FluxDispatcher: { props: [["dispatch", "subscribe"]] },
    InviteActions: { props: [["acceptInvite", "resolveInvite"]] },
    AuthTokenStore: { props: [["getToken"], ["getCachedToken"]] },
    MuteStore: { props: [["isMuted", "getMuteConfig"]] },
    MuteActions: { props: [["updateGuildNotificationSettings", "updateChannelOverrideSettings"]] },
    GuildActions: { props: [["leaveGuild"]] },
    GatewayConnectionStore: { props: [["getSocket", "isTryingToConnect"]] },
    SuperProperties: { props: [["getSuperPropertiesBase64"]], optional: true },
    CloudUpload: { code: ["uploadAnalytics", "preCompressionSize"] },
    // The same module emits both events; found by what its functions dispatch.
    ReactionActions: {
        lazy: true,
        // Over the module cache by hand: W.find gives up at a module whose exports throw when read.
        find: W => {
            const sources = m => { try { return Object.values(m).filter(v => typeof v === "function").map(v => Function.prototype.toString.call(v)); } catch { return []; } };
            for (const id in W.wreq.c) {
                let m;
                try { m = W.wreq.c[id]?.exports; } catch { continue; }
                if (!m || typeof m !== "object") continue;
                const fns = sources(m);
                if (fns.some(f => f.includes('"MESSAGE_REACTION_ADD"')) && fns.some(f => f.includes('"MESSAGE_REACTION_REMOVE"'))) return m;
            }
        },
    },
    PreloadedUserSettings: { find: W => (W.findAll?.(m => m?.ProtoClass && m?.updateAsync) ?? []).find(m => m.type === 1) },
    "source:chat-messages": { source: "chat-messages", lazy: true },
    "source:messagesWrapper": { source: "messagesWrapper", lazy: true },
    "source:optionButtonWrapper": { source: "optionButtonWrapper", optional: true, lazy: true },
};

const found = new Map();

function resolve(spec) {
    const W = Web();
    if (!W) return undefined;
    if (spec.props) {
        for (const p of spec.props) {
            const m = W.findByProps(...p);
            if (m) return m;
        }
        return undefined;
    }
    if (spec.code) return W.findByCode(...spec.code);
    if (spec.find) return spec.find(W);
    return undefined;
}

/** One of Discord's internals; undefined when it can't be found (the self-test reports that). */
function need(name) {
    if (!found.has(name)) {
        let m;
        try { m = resolve(NEEDS[name]); } catch { /* reported as missing */ }
        if (!m) return undefined;
        found.set(name, m);
    }
    return found.get(name);
}

/** Discord's API, with the headers its own client sends. */
function api(url, init = {}) {
    const headers = { ...init.headers };
    try {
        const sp = need("SuperProperties")?.getSuperPropertiesBase64?.();
        if (sp) headers["x-super-properties"] = sp;
    } catch { /* optional */ }
    return fetch(url, { ...init, headers });
}

/* ------------------------------------------------------------ navigation -- */

/** How long a channel gets to show up after navigating, its first messages coming from the network. */
const RENDER_WAIT_MS = 10_000;

/** Whether the page really shows this channel: its route, and its messages in the list (or a
 * loaded channel with none). The store alone says nothing about what's on the page. */
function shows(channelId, messageId) {
    if (!location.pathname.split("/").includes(channelId)) return false;
    if (!document.querySelector('[data-list-id="chat-messages"]')) return false;
    if (messageId) return !!document.getElementById(`chat-messages-${channelId}-${messageId}`);
    if (document.querySelector(`[id^="chat-messages-${channelId}-"]`)) return true;
    const loaded = need("MessageStore")?.getMessages?.(channelId);
    return !!loaded?.ready && !loaded.length;
}

/** Goes to a channel as the sidebar does; whether it's on the page by the end. */
async function navigate(channelId, guildId, messageId) {
    if (shows(channelId, messageId)) return true;
    const known = !!need("ChannelStore")?.getChannel?.(channelId);
    const router = need("ChannelRouter");
    if (known && !messageId && router) router.transitionToChannel(channelId);
    else {
        const nav = need("NavigationRouter");
        if (!nav) throw new Error("NavigationRouter not found — webpack module shape may have changed.");
        // A DM that was only just created isn't in the store yet: the router would skip it.
        nav.transitionTo(`/channels/${guildId ?? "@me"}/${channelId}` + (messageId ? "/" + messageId : ""));
    }
    const until = Date.now() + RENDER_WAIT_MS;
    while (Date.now() < until) {
        if (shows(channelId, messageId)) return true;
        await sleep(100);
    }
    return false;
}

/* ------------------------------------------------------- send message -- */

/**
 * Send a message natively via Discord's MessageActions — exposed at
 * the `discord_send` tool.
 *
 * Path A (no files): `MessageActions.sendMessage(channelId, msg, true, opts)`
 *   — the same code path Discord's own composer uses; passes through mention
 *   parsing, slash-command sniffing, reply refs, etc.
 *
 * Path B (files): wrap each File in a `CloudUpload` and pass them as
 *   `options.attachmentsToUpload` to the same `sendMessage` — `_sendMessage`
 *   runs the upload pipeline + send together, no attach modal.
 *
 * Always returns the resolved channel info so the agent can verify *where*
 * the message landed before trusting the send.
 */
async function bridgeSendMessage(args) {

    const SelectedChannelStore = need("SelectedChannelStore");
    const ChannelStore = need("ChannelStore");
    const ChannelActions = need("ChannelActions");
    const MessageActions = need("MessageActions");
    const GuildStore = need("GuildStore");

    const id = args.channelId || SelectedChannelStore?.getChannelId?.();
    if (!id) throw new Error("No channel selected and no channelId provided.");
    const channel = ChannelStore?.getChannel?.(id);
    if (!channel) throw new Error("Channel not found: " + id);

    const channelInfo = {
        id,
        name: channel.name || (channel.recipients?.length ? "(DM)" : null),
        guildId: channel.guild_id || null,
        guildName: channel.guild_id
            ? (GuildStore?.getGuild?.(channel.guild_id)?.name ?? null)
            : null,
    };

    const messageReference = args.replyToMessageId ? {
        message_id: args.replyToMessageId,
        channel_id: id,
        guild_id: channel.guild_id || undefined,
    } : undefined;

    // Pre-validate replyToMessageId against the local MessageStore. Discord
    // rejects replies to unknown message IDs with a Clyde "could not be
    // delivered" DM — but the local renderer optimistically shows the message
    // anyway, so the failure is invisible to the caller. Catching it here
    // turns a silent delivery failure into a surfaced error.
    if (args.replyToMessageId) {
        const MessageStore = need("MessageStore");
        const stored = MessageStore?.getMessage?.(id, args.replyToMessageId);
        if (!stored) {
            throw new Error(
                `replyToMessageId ${args.replyToMessageId} not found in channel ${id}'s ` +
                "local message store. Discord would reject this reply with a Clyde error. " +
                "Pull message IDs from a fresh discord_view result for this channel."
            );
        }
    }

    const tts = !!args.tts;
    const content = args.content ?? "";

    // Optional "pretend to be typing" pause before the send fires. `typingMs`
    // is explicit; `typing: true` auto-derives from content length, ~60ms/char
    // clamped to [800ms, 6000ms] — roughly natural human pacing. Discord
    // stops the typing indicator automatically when the message lands, so no
    // explicit stopTyping needed.
    let typingMs;
    if (typeof args.typingMs === "number" && args.typingMs > 0) typingMs = args.typingMs;
    else if (args.typing) {
        const len = content.length;
        typingMs = Math.max(800, Math.min(6000, len * 60));
    }
    if (typingMs) {
        const TypingActions = need("TypingActions");
        if (TypingActions?.startTyping) {
            try { TypingActions.startTyping(id); } catch { /* */ }
            // Discord's typing indicator self-times out after ~10s; repeat the
            // start every ~8s so longer pretend-typing durations stay visible.
            const start = Date.now();
            while (Date.now() - start < typingMs) {
                const remaining = typingMs - (Date.now() - start);
                await new Promise(r => setTimeout(r, Math.min(remaining, 8000)));
                if (Date.now() - start < typingMs) {
                    try { TypingActions.startTyping(id); } catch { /* */ }
                }
            }
        }
    }

    // Snapshot the user's current channel as late as possible — right before we
    // switch away — so if they navigated somewhere during the typing pause above,
    // the `finally` restores them to where they actually are now, not where they
    // were when the send started. An agent send must never leave the user's
    // client parked on someone else's DM.
    const prevChannelId = SelectedChannelStore?.getChannelId?.() ?? null;
    const switchedChannel = !!(ChannelActions?.selectChannel && prevChannelId !== id);

    // Pre-flight: if the renderer is on a different channel, `sendMessage`'s
    // wait-for-channel-ready can hang forever (Discord waits for the channel to
    // open in the UI, but nothing here opens it). Select first; the send path
    // also passes `false` below to belt-and-suspenders the wedge. Typing is
    // keyed by channel id, so it already fired above without the switch — this
    // only shows the target channel for the actual send + the restore below.
    if (switchedChannel) {
        ChannelActions.selectChannel({ guildId: channel.guild_id || null, channelId: id });
        const deadline = Date.now() + 1500;
        while (Date.now() < deadline) {
            if (SelectedChannelStore?.getChannelId?.() === id) break;
            await new Promise(r => setTimeout(r, 25));
        }
    }

    try {
    if (args.files?.length) {
        const fileObjs = args.files.map(f => {
            const bin = atob(f.base64);
            const arr = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
            return new File([arr], f.name, { type: f.mime || "application/octet-stream" });
        });

        // Discord retired the old `UploadManager.uploadFiles(...)` one-shot.
        // New flow: build CloudUpload instances per file, then call
        // `MessageActions.sendMessage` with them in `options.attachmentsToUpload`
        // — `_sendMessage` runs the upload pipeline + send in one go.
        const CloudUpload = need("CloudUpload");
        if (typeof CloudUpload !== "function")
            throw new Error("CloudUpload class not found — webpack module shape may have changed.");
        if (!MessageActions?.sendMessage)
            throw new Error("MessageActions.sendMessage not found — webpack module shape may have changed.");

        const uploads = fileObjs.map(file => new CloudUpload({
            file,
            platform: 1, // WEB
            isClip: false,
            isThumbnail: false,
        }, id));

        await MessageActions.sendMessage(id, {
            content,
            invalidEmojis: [],
            validNonShortcutEmojis: [],
            tts,
        }, false, {
            attachmentsToUpload: uploads,
            ...(messageReference ? { messageReference } : {}),
        });
    } else {
        if (!content.trim())
            throw new Error("`content` is required when no `files` are provided.");
        if (!MessageActions?.sendMessage)
            throw new Error("MessageActions.sendMessage not found — webpack module shape may have changed.");

        // 4th arg is `options` — Discord reads `.nonce` off it unconditionally,
        // so must be an object (never undefined). 3rd arg is the
        // "wait-for-channel-ready" boolean — `false` here because we pre-select
        // the channel above, and waiting can hang indefinitely if the channel
        // is not loaded in the UI.
        await MessageActions.sendMessage(id, {
            content,
            invalidEmojis: [],
            validNonShortcutEmojis: [],
            tts,
        }, false, messageReference ? { messageReference } : {});
    }
    } finally {
        // Best-effort restore of the user's pre-send channel; a restore failure
        // must never mask the send result. prevChannelId is null when no channel
        // was open (home / guild-home), so restore is skipped in that case.
        if (switchedChannel && prevChannelId) {
            try {
                const prevChannel = ChannelStore?.getChannel?.(prevChannelId);
                ChannelActions.selectChannel({
                    guildId: prevChannel?.guild_id || null,
                    channelId: prevChannelId,
                });
            } catch { /* view restore is best-effort */ }
        }
    }

    return {
        ok: true,
        channel: channelInfo,
        content,
        fileCount: args.files?.length || 0,
        replyTo: args.replyToMessageId || null,
        tts,
    };
}

/* ----------------------------------------------------- view current view -- */

/**
 * Read what the user is currently looking at — the selected channel and the
 * messages rendered in the viewport. Discord virtualizes off-screen messages
 * out of the DOM, so scraping `[id^="chat-messages-"]` is naturally
 * scroll-scoped: if the user scrolled up to look at history, *that* is what
 * the agent sees here.
 *
 * Each rendered ID is then looked up in MessageStore for full message data
 * (author, attachments, reply refs, reactions) — DOM gives the viewport,
 * webpack gives the fidelity.
 */
async function bridgeGetView(args = {}) {

    const SelectedChannelStore = need("SelectedChannelStore");
    const ChannelStore = need("ChannelStore");
    const MessageStore = need("MessageStore");
    const UserStore = need("UserStore");
    const GuildStore = need("GuildStore");

    const channelId = SelectedChannelStore?.getChannelId?.();
    if (!channelId) throw new Error("No channel currently selected.");
    const channel = ChannelStore?.getChannel?.(channelId);
    if (!channel) throw new Error("Selected channel not found in ChannelStore: " + channelId);

    const guild = channel.guild_id ? GuildStore?.getGuild?.(channel.guild_id) : null;
    const viewer = UserStore?.getCurrentUser?.();

    // Discord message DOM IDs: `chat-messages-${channelId}-${messageId}` (or
    // older `chat-messages-${messageId}` in some surfaces). Pull the trailing
    // digit run either way; preserve render order; de-dupe.
    const els = [...document.querySelectorAll('[id^="chat-messages-"]')];
    const limit = Math.max(1, Math.min(200, args.limit ?? 100));
    const seen = new Set();
    const ids = [];
    for (const el of els) {
        const m = (el.id || "").match(/(\d{15,})\s*$/);
        if (!m) continue;
        const id = m[1];
        if (seen.has(id)) continue;
        seen.add(id);
        ids.push(id);
    }

    const slice = ids.slice(-limit);
    const renderName = (u) =>
        u?.globalName ?? u?.global_name ?? u?.username ?? null;
    const tsIso = (t) =>
        typeof t?.toISOString === "function" ? t.toISOString() : (t ? String(t) : null);

    const messages = [];
    let unresolved = 0;
    for (const id of slice) {
        const msg = MessageStore?.getMessage?.(channelId, id);
        if (!msg) { unresolved++; continue; }
        const out = {
            id: msg.id,
            timestamp: tsIso(msg.timestamp),
            author: msg.author ? {
                id: msg.author.id,
                username: msg.author.username,
                name: renderName(msg.author),
                bot: !!msg.author.bot,
            } : null,
            content: msg.content || "",
        };
        const edited = tsIso(msg.editedTimestamp);
        if (edited) out.edited = edited;

        if (msg.attachments?.length) {
            out.attachments = msg.attachments.map((a) => ({
                name: a.filename || a.name,
                url: a.url,
                contentType: a.content_type || a.contentType,
                size: a.size,
                width: a.width, height: a.height,
            }));
        }

        if (msg.messageReference?.message_id) {
            const refId = msg.messageReference.message_id;
            const refChan = msg.messageReference.channel_id || channelId;
            const ref = MessageStore?.getMessage?.(refChan, refId);
            out.replyTo = ref ? {
                id: ref.id,
                authorId: ref.author?.id,
                authorName: renderName(ref.author),
                contentPreview: (ref.content || "").slice(0, 160),
            } : { id: refId, unloaded: true };
        }

        if (msg.mentions?.length) {
            out.mentions = msg.mentions.map((m) =>
                typeof m === "string" ? { id: m } : { id: m.id, name: renderName(m) });
        }
        if (msg.mentionRoles?.length) out.mentionRoles = [...msg.mentionRoles];
        if (msg.mentionEveryone) out.mentionEveryone = true;

        if (msg.embeds?.length) {
            if (args.includeEmbeds) {
                out.embeds = msg.embeds.map((e) => ({
                    type: e.type,
                    title: e.title,
                    description: (e.description || e.rawDescription || "").slice(0, 400),
                    url: e.url,
                    author: e.author?.name,
                    providerName: e.provider?.name,
                }));
            } else {
                out.embedCount = msg.embeds.length;
            }
        }

        if (msg.reactions?.length) {
            if (args.includeReactions) {
                out.reactions = msg.reactions.map((r) => ({
                    emoji: r.emoji?.name || r.emoji?.id || String(r.emoji),
                    count: r.count, me: !!r.me,
                }));
            } else {
                out.reactionCount = msg.reactions.length;
            }
        }

        if (msg.flags) out.flags = msg.flags;
        if (msg.pinned) out.pinned = true;
        if (msg.type && msg.type !== 0) out.type = msg.type;

        messages.push(out);
    }

    // The chat scroller — its scrollTop / atBottom hint tells the agent
    // whether the user is following live (bottom) or browsing history.
    const scroller = document.querySelector(
        '[class*="messagesWrapper"] [class*="scroller"], [data-list-id="chat-messages"]');
    const scrollInfo = scroller ? {
        scrollTop: Math.round(scroller.scrollTop),
        scrollHeight: scroller.scrollHeight,
        clientHeight: scroller.clientHeight,
        atBottom: scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 4,
    } : null;

    // Inline reply-chain expansion: for each rendered message with a `replyTo`,
    // walk up to N parents (REST-fetching any that aren't in MessageStore) and
    // embed them as `replyChain` (oldest→newest). Removes `{unloaded: true}`
    // limitations for replies whose parent was scrolled out.
    const resolveDepth = Math.max(0, Math.min(20, args.resolveReplies ?? 0));
    if (resolveDepth > 0) {
        const token = getAuthToken();
        for (const m of messages) {
            const startId = m.replyTo?.id;
            if (!startId) continue;
            try {
                m.replyChain = await walkReplyChain(channelId, startId, resolveDepth, token);
                if (m.replyTo?.unloaded && m.replyChain.length) {
                    // Replace the placeholder with the resolved tip so callers
                    // don't have to look at two fields.
                    const tip = m.replyChain[m.replyChain.length - 1];
                    if (tip && !tip.unloaded) {
                        m.replyTo = {
                            id: tip.id,
                            authorId: tip.author?.id,
                            authorName: tip.author?.name,
                            contentPreview: (tip.content || "").slice(0, 160),
                        };
                    }
                }
            } catch { /* leave the shallow replyTo alone on failure */ }
        }
    }

    // Participants: presence + typing for the people actually in this channel.
    // For DMs/groups use channel.recipients; for guild channels we don't have a
    // member list cheaply, so fall back to recent message authors in `messages`.
    const PresenceStore = need("PresenceStore");
    const TypingStore = need("TypingStore");
    const recipientIds = channel.recipients || channel.recipientIds || [];
    const participantIds = new Set        (recipientIds);
    if (!participantIds.size) {
        for (const m of messages) if (m.author?.id) participantIds.add(m.author.id);
    }
    if (viewer?.id) participantIds.add(viewer.id);
    const typingMap = TypingStore?.getTypingUsers?.(channelId) || {};
    const typingSet = new Set        (Array.isArray(typingMap) ? typingMap : Object.keys(typingMap));
    const participants = [...participantIds].map(uid => {
        const u = UserStore?.getUser?.(uid);
        return {
            userId: uid,
            name: renderName(u) || null,
            presence: PresenceStore?.getStatus?.(uid) || "offline",
            typing: typingSet.has(uid),
        };
    });

    return {
        channel: {
            id: channel.id,
            name: channel.name || (channel.recipients?.length ? "(DM)" : null),
            type: channel.type,
            topic: channel.topic || null,
            guildId: channel.guild_id || null,
            guildName: guild?.name || null,
            parentId: channel.parent_id || null,
        },
        viewer: viewer ? {
            id: viewer.id,
            username: viewer.username,
            name: renderName(viewer),
        } : null,
        scroll: scrollInfo,
        participants,
        renderedCount: messages.length,
        unresolved,
        messages,
    };
}

/* ------------------------------------------------------- list DMs -------- */

/**
 * List DM + group-DM channels in sidebar order, optionally ranked against a
 * query string. Lets an agent resolve "Ana" → channelId without the user
 * having to dig out an opaque ID.
 *
 * Match score, highest wins: exact (100) > prefix (75) > substring (50).
 * Scored across the DM display name, every recipient's display name, and
 * every recipient's username.
 */
function bridgeListDMs(args = {}) {

    const ChannelStore = need("ChannelStore");
    const UserStore = need("UserStore");
    const SortStore = need("PrivateChannelSortStore");
    // Discord's native friend-nickname store — what the sidebar actually
    // shows when a user has renamed a friend (e.g. "Sam" → "Nickname").
    const RelationshipStore = need("RelationshipStore");

    // Get DM channel IDs in the order Discord shows them in the sidebar; fall
    // back to ChannelStore directly if the sort store moved/renamed.
    let dmIds = [];
    if (typeof SortStore?.getPrivateChannelIds === "function") {
        dmIds = SortStore.getPrivateChannelIds();
    } else if (typeof ChannelStore?.getSortedPrivateChannels === "function") {
        dmIds = ChannelStore.getSortedPrivateChannels().map((c) => c.id);
    } else if (typeof ChannelStore?.getMutablePrivateChannels === "function") {
        dmIds = Object.keys(ChannelStore.getMutablePrivateChannels());
    } else {
        throw new Error("No DM-listing webpack module found (getPrivateChannelIds / getSortedPrivateChannels / getMutablePrivateChannels).");
    }

    const renderName = (u) => u?.globalName ?? u?.global_name ?? u?.username ?? null;

    const all = dmIds.map(id => {
        const ch = ChannelStore?.getChannel?.(id);
        if (!ch) return null;
        const isGroup = ch.type === 3;
        const recipientIds = ch.recipients || ch.recipientIds || [];
        const recipients = recipientIds.map(rid => {
            const u = UserStore?.getUser?.(rid);
            const nickname = RelationshipStore?.getNickname?.(rid) || null;
            return u ? {
                id: u.id,
                username: u.username,
                name: renderName(u),
                nickname,
                bot: !!u.bot,
            } : { id: rid, nickname };
        });
        // For 1:1 DMs, prefer the friend-nickname so the listed `name` matches
        // what the user actually sees in the sidebar — that is what they will
        // type when asking the agent to send to "Nickname".
        const name = isGroup
            ? (ch.name || recipients.map(r => (r).nickname || r.name || r.username).filter(Boolean).join(", ") || "(group)")
            : ((recipients[0]       )?.nickname || recipients[0]?.name || recipients[0]?.username || "(unknown)");
        return {
            channelId: id,
            kind: isGroup ? "group" : "dm",
            name,
            memberCount: isGroup ? recipients.length : undefined,
            recipients,
        };
    }).filter(Boolean);

    const q = (args.query || "").trim().toLowerCase();
    let results = all;
    if (q) {
        const score = (dm) => {
            const targets = [
                dm.name,
                ...dm.recipients.flatMap(r => [(r).nickname, r.name, r.username]),
            ];
            let best = -1;
            for (const t of targets) {
                const lo = (t || "").toLowerCase();
                if (!lo) continue;
                if (lo === q) best = Math.max(best, 100);
                else if (lo.startsWith(q)) best = Math.max(best, 75);
                else if (lo.includes(q)) best = Math.max(best, 50);
            }
            return best;
        };
        results = all
            .map(dm => ({ dm, s: score(dm) }))
            .filter(x => x.s >= 0)
            .sort((a, b) => b.s - a.s)
            .map(x => x.dm);
    }

    const limit = Math.max(1, Math.min(100, args.limit ?? (q ? 20 : 50)));
    return {
        total: all.length,
        matched: q ? results.length : undefined,
        query: q || undefined,
        dms: results.slice(0, limit),
    };
}

/* --------------------------------------------- history / search / stats -- */

const DISCORD_EPOCH = 1420070400000n;

function snowflakeToIso(snowflake) {
    try { return new Date(Number((BigInt(snowflake) >> 22n) + DISCORD_EPOCH)).toISOString(); }
    catch { return null; }
}

/** ISO timestamp (or Date-parseable string) → Discord snowflake bound. */
function isoToSnowflake(iso) {
    const ms = Date.parse(iso);
    if (!Number.isFinite(ms)) return null;
    return (((BigInt(ms) - DISCORD_EPOCH) << 22n)).toString();
}

/** Pull the live user auth token from Discord's webpack stores. */
function getAuthToken() {
    const m = need("AuthTokenStore");
    const tok = m?.getToken?.() || m?.getCachedToken?.();
    if (!tok) throw new Error("Auth token unavailable from webpack — not logged in, or token store moved.");
    return tok;
}

/** Raw REST message → caller-facing projection driven by `select`. `id` always present. */
function projectMessage(msg, select) {
    const out = { id: msg.id };
    if (select.has("content")) out.content = msg.content || "";
    if (select.has("timestamp")) out.timestamp = msg.timestamp || snowflakeToIso(msg.id);
    if (select.has("author") && msg.author) out.author = {
        id: msg.author.id,
        username: msg.author.username,
        name: msg.author.global_name ?? msg.author.globalName ?? msg.author.username,
        bot: !!msg.author.bot,
    };
    if (select.has("attachments") && msg.attachments?.length) {
        out.attachments = msg.attachments.map((a) => ({
            name: a.filename || a.name,
            url: a.url,
            size: a.size,
            contentType: a.content_type || a.contentType,
            width: a.width, height: a.height,
        }));
    }
    if (select.has("replyTo") && msg.message_reference?.message_id) {
        out.replyTo = {
            id: msg.message_reference.message_id,
            channelId: msg.message_reference.channel_id,
        };
    }
    if (select.has("mentions") && msg.mentions?.length) {
        out.mentions = msg.mentions.map((u) => ({
            id: u.id, name: u.global_name ?? u.globalName ?? u.username,
        }));
    }
    if (select.has("reactions") && msg.reactions?.length) {
        out.reactions = msg.reactions.map((r) => ({
            emoji: r.emoji?.name || r.emoji?.id || String(r.emoji),
            count: r.count, me: !!r.me,
        }));
    }
    if (select.has("edited") && msg.edited_timestamp) out.edited = msg.edited_timestamp;
    return out;
}

/** GET /channels/{id}/messages with retry on 429. Returns raw Discord array. */
async function restFetchMessages(channelId, params, token) {
    const u = new URL(`https://discord.com/api/v9/channels/${channelId}/messages`);
    for (const [k, v] of Object.entries(params)) if (v != null) u.searchParams.set(k, String(v));
    const r = await api(u.toString(), { headers: { authorization: token } });
    if (r.status === 429) {
        const j = await r.json().catch(() => ({}));
        const wait = Math.min(10_000, Math.max(250, (j.retry_after || 1) * 1000));
        await sleep(wait);
        return restFetchMessages(channelId, params, token);
    }
    if (!r.ok) {
        const body = await r.text().catch(() => "");
        throw new Error(`Discord REST /messages error ${r.status}: ${body.slice(0, 300)}`);
    }
    return r.json();
}

/**
 * Paginated channel history via Discord REST. Walks newest→oldest in 100-msg
 * batches, applying client-side filters (`from`, `contains`, `since`/`until`)
 * since the REST endpoint doesn't natively support them. Returns oldest-first
 * so the agent can read it like a transcript, plus a `nextBefore` cursor for
 * deeper paging.
 *
 * `select` is field projection — defaults to the cheap set. Use it.
 */
async function bridgeGetHistory(args = {}) {

    const ChannelStore = need("ChannelStore");
    const SelectedChannelStore = need("SelectedChannelStore");

    const channelId = args.channelId || SelectedChannelStore?.getChannelId?.();
    if (!channelId) throw new Error("No channel selected and no channelId provided.");
    const channel = ChannelStore?.getChannel?.(channelId);

    const token = getAuthToken();
    const selectKeys = new Set        (
        args.select?.length ? args.select : ["id", "content", "author", "timestamp"]
    );
    // resolveReplies needs `replyTo` in the projection — auto-add so callers
    // don't have to remember the dependency.
    const resolveDepth = Math.max(0, Math.min(20, args.resolveReplies ?? 0));
    if (resolveDepth > 0) selectKeys.add("replyTo");
    const limit = Math.max(1, Math.min(5000, args.limit ?? 200));

    // ISO → snowflake fallback for since/until when explicit before/after not set.
    let before = args.before || (args.until ? isoToSnowflake(args.until) : null) || undefined;
    const after = args.after || (args.since ? isoToSnowflake(args.since) : null) || undefined;

    const fromId = args.from || null;
    const containsLo = args.contains ? args.contains.toLowerCase() : null;
    const lowerBound = after ? BigInt(after) : null;

    const out = [];
    let cursor = before;
    let reachedEnd = false;
    let pages = 0;

    // Single-call `around` mode — Discord returns 50 each side; ignore paging.
    if (args.around && !cursor) {
        const batch = await restFetchMessages(channelId, { limit: 100, around: args.around }, token);
        for (const m of batch) {
            if (fromId && m.author?.id !== fromId) continue;
            if (containsLo && !(m.content || "").toLowerCase().includes(containsLo)) continue;
            out.push(projectMessage(m, selectKeys));
        }
        reachedEnd = true;
    } else {
        while (out.length < limit) {
            const params = { limit: 100 };
            if (cursor) params.before = cursor;
            const batch = await restFetchMessages(channelId, params, token);
            pages++;
            if (!batch.length) { reachedEnd = true; break; }

            let stop = false;
            for (const m of batch) {
                if (lowerBound && BigInt(m.id) <= lowerBound) { stop = true; continue; }
                if (fromId && m.author?.id !== fromId) continue;
                if (containsLo && !(m.content || "").toLowerCase().includes(containsLo)) continue;
                out.push(projectMessage(m, selectKeys));
                if (out.length >= limit) break;
            }
            cursor = batch[batch.length - 1].id;
            if (batch.length < 100) { reachedEnd = true; break; }
            if (stop) { reachedEnd = true; break; }
        }
    }

    // Currently newest-first → flip to oldest-first.
    out.reverse();

    // Inline reply-chain expansion (post-loop so we only walk for projected messages).
    if (resolveDepth > 0) {
        for (const m of out) {
            const startId = m.replyTo?.id;
            if (!startId) continue;
            try {
                m.replyChain = await walkReplyChain(
                    m.replyTo.channelId || channelId, startId, resolveDepth, token);
            } catch { /* */ }
        }
    }

    return {
        channel: channel ? {
            id: channel.id,
            name: channel.name || (channel.recipients?.length ? "(DM)" : null),
            type: channel.type,
            guildId: channel.guild_id || null,
        } : { id: channelId },
        count: out.length,
        pagesFetched: pages,
        hasMoreBefore: !reachedEnd,
        nextBefore: !reachedEnd ? cursor || null : null,
        oldestId: out[0]?.id || null,
        newestId: out[out.length - 1]?.id || null,
        messages: out,
    };
}

/**
 * Wraps Discord's `/messages/search` endpoint. Uses the guild-level URL for
 * guild channels (with `channel_id=` constraint), channel-level for DMs/groups.
 * Auto-loops `offset` pagination up to `limit`. Surfaces indexing/rate-limit
 * responses so the caller can decide what to do.
 */
async function bridgeSearchMessages(args) {
    if (!args.query || !args.query.trim()) throw new Error("`query` is required.");

    const ChannelStore = need("ChannelStore");
    const SelectedChannelStore = need("SelectedChannelStore");

    const channelId = args.channelId || SelectedChannelStore?.getChannelId?.();
    if (!channelId) throw new Error("No channel selected and no channelId provided.");
    const channel = ChannelStore?.getChannel?.(channelId);
    const token = getAuthToken();
    const limit = Math.max(1, Math.min(200, args.limit ?? 25));

    const base = channel?.guild_id
        ? `https://discord.com/api/v9/guilds/${channel.guild_id}/messages/search`
        : `https://discord.com/api/v9/channels/${channelId}/messages/search`;

    const baseParams = new URLSearchParams();
    baseParams.set("content", args.query);
    if (channel?.guild_id) baseParams.set("channel_id", channelId);
    if (args.from) baseParams.set("author_id", args.from);
    if (args.mentions) baseParams.set("mentions", args.mentions);
    for (const h of args.has || []) baseParams.append("has", h);
    if (args.before) baseParams.set("max_id", args.before);
    if (args.after) baseParams.set("min_id", args.after);

    const collected = [];
    let totalResults = 0;
    let offset = 0;
    const selectKeys = new Set(["id", "content", "author", "timestamp", "attachments"]);

    while (collected.length < limit) {
        const p = new URLSearchParams(baseParams);
        p.set("offset", String(offset));
        const r = await api(`${base}?${p.toString()}`, { headers: { authorization: token } });

        if (r.status === 202) {
            const j = await r.json().catch(() => ({}));
            return {
                indexing: true,
                retryAfter: j.retry_after || null,
                message: "Discord is indexing this channel for search. Retry after `retryAfter` seconds.",
            };
        }
        if (r.status === 429) {
            const j = await r.json().catch(() => ({}));
            await sleep(Math.min(10_000, Math.max(250, (j.retry_after || 1) * 1000)));
            continue;
        }
        if (!r.ok) {
            const body = await r.text().catch(() => "");
            throw new Error(`Discord search error ${r.status}: ${body.slice(0, 300)}`);
        }

        const j = await r.json();
        totalResults = j.total_results ?? totalResults;
        if (!j.messages?.length) break;

        for (const group of j.messages) {
            const hit = group.find?.((m) => m.hit) || group[Math.floor(group.length / 2)] || group[0];
            if (!hit) continue;
            collected.push({ ...projectMessage(hit, selectKeys), hit: true });
            if (collected.length >= limit) break;
        }

        offset += j.messages.length;
        if (j.messages.length < 25) break;     // Discord page size — last page
    }

    return {
        channel: channel ? {
            id: channel.id,
            name: channel.name || (channel.recipients?.length ? "(DM)" : null),
            guildId: channel.guild_id || null,
        } : { id: channelId },
        query: args.query,
        totalResults,
        count: collected.length,
        messages: collected,
    };
}

/**
 * Search a guild for messages by a specific author. This intentionally uses a
 * bounded page shape instead of trying to dump an unbounded server history.
 */
async function bridgeUserMessages(args) {
    if (!/^\d{15,25}$/.test(args.guildId || "")) throw new Error("`guildId` must be a Discord snowflake.");
    if (!/^\d{15,25}$/.test(args.userId || "")) throw new Error("`userId` must be a Discord snowflake.");

    const GuildStore = need("GuildStore");
    const guild = GuildStore?.getGuild?.(args.guildId);
    const token = getAuthToken();
    const limit = Math.max(1, Math.min(500, args.limit ?? 100));
    const startOffset = Math.max(0, args.offset ?? 0);

    const base = `https://discord.com/api/v9/guilds/${args.guildId}/messages/search`;
    const baseParams = new URLSearchParams();
    baseParams.set("author_id", args.userId);
    if (args.query?.trim()) baseParams.set("content", args.query.trim());
    if (args.before) baseParams.set("max_id", args.before);
    if (args.after) baseParams.set("min_id", args.after);

    const selectKeys = new Set(["id", "content", "author", "timestamp", "attachments", "replyTo", "mentions"]);
    const collected = [];
    let totalResults = 0;
    let offset = startOffset;
    let indexing = false;
    let retryAfter = null;

    while (collected.length < limit) {
        const p = new URLSearchParams(baseParams);
        p.set("offset", String(offset));
        const r = await api(`${base}?${p.toString()}`, { headers: { authorization: token } });

        if (r.status === 202) {
            const j = await r.json().catch(() => ({}));
            indexing = true;
            retryAfter = j.retry_after || null;
            break;
        }
        if (r.status === 429) {
            const j = await r.json().catch(() => ({}));
            await sleep(Math.min(10_000, Math.max(250, (j.retry_after || 1) * 1000)));
            continue;
        }
        if (!r.ok) {
            const body = await r.text().catch(() => "");
            throw new Error(`Discord guild user search error ${r.status}: ${body.slice(0, 300)}`);
        }

        const j = await r.json();
        totalResults = j.total_results ?? totalResults;
        if (!j.messages?.length) break;

        let consumedGroups = 0;
        for (const group of j.messages) {
            consumedGroups++;
            const hit = group.find?.((m) => m.hit) || group[Math.floor(group.length / 2)] || group[0];
            if (!hit) continue;
            collected.push({
                ...projectMessage(hit, selectKeys),
                channelId: hit.channel_id || hit.channelId || null,
                guildId: args.guildId,
                hit: true,
            });
            if (collected.length >= limit) break;
        }

        offset += consumedGroups;
        if (j.messages.length < 25) break;
    }

    return {
        guild: guild ? { id: guild.id, name: guild.name } : { id: args.guildId },
        userId: args.userId,
        query: args.query?.trim() || null,
        limit,
        offset: startOffset,
        nextOffset: startOffset + collected.length < totalResults ? startOffset + collected.length : null,
        hasMore: startOffset + collected.length < totalResults,
        totalResults,
        count: collected.length,
        indexing,
        retryAfter,
        messages: collected,
    };
}

/**
 * Strip-words list — PT + EN chat noise. Stored accent-stripped + lowercase;
 * words from messages are normalized the same way before lookup, so casual PT
 * typing ("nao", "voce", "ja") matches the canonical form ("não", "você", "já").
 */
const RAW_STOPWORDS = [
    // EN
    "the", "and", "for", "are", "but", "not", "you", "your", "yours", "with", "this", "that", "from", "have",
    "has", "had", "was", "were", "will", "would", "could", "should", "can", "may", "might", "just", "like",
    "what", "when", "where", "why", "how", "who", "which", "than", "then", "into", "over", "about", "out",
    "all", "any", "some", "one", "two", "get", "got", "going", "yeah", "yes", "ok", "okay", "lol", "haha",
    "really", "very", "much", "only", "also", "even", "still", "now", "here", "there", "their", "them",
    "they", "his", "her", "him", "she", "its", "our", "ours", "mine", "myself", "yourself",
    "been", "being", "does", "did", "doing", "done", "say", "said", "says", "see", "seen", "know", "knew",
    // PT
    "que", "para", "com", "como", "uma", "uns", "umas", "dos", "das", "nas", "nos", "por", "pelo", "pela",
    "pelos", "pelas", "sem", "mais", "menos", "muito", "muita", "muitos", "muitas", "tão", "também", "ainda",
    "agora", "depois", "antes", "sempre", "nunca", "aqui", "ali", "lá", "cá", "isto", "isso", "aquilo",
    "este", "esta", "esse", "essa", "aquele", "aquela", "estes", "estas", "esses", "essas", "aqueles", "aquelas",
    "meu", "minha", "meus", "minhas", "teu", "tua", "seu", "sua", "seus", "suas",
    "nosso", "nossa", "nossos", "nossas", "dele", "dela", "deles", "delas",
    "ser", "ter", "estar", "estou", "está", "estão", "estava", "estavam", "foi", "fui", "foram", "fosse",
    "são", "ele", "ela", "eles", "elas", "você", "vocês", "nós", "vós", "eu", "tu",
    "não", "sim", "então", "porque", "porquê", "pra", "pro", "tá", "tô", "né", "aí",
    "mas", "ou", "se", "já", "só", "vai", "vão", "vou", "vamos", "vem", "veio", "ver",
    "fazer", "feito", "faz", "fez", "ter", "tem", "tinha", "teve", "tive", "havia",
    "até", "onde", "qual", "quem", "quando",
];

const stripAccents = (s) => s.normalize("NFD").replace(/[̀-ͯ]/g, "");
const STOPWORDS = new Set        (RAW_STOPWORDS.map(w => stripAccents(w.toLowerCase())));

const URL_RE = /https?:\/\/([^\s/]+)/gi;
const WORD_RE = /[a-zA-ZÀ-ſ]{3,}/g;

function bucketOf(iso, groupBy) {
    const d = new Date(iso);
    if (groupBy === "day") return d.toISOString().slice(0, 10);
    if (groupBy === "week") {
        const jan1 = Date.UTC(d.getUTCFullYear(), 0, 1);
        const dayOfYear = Math.floor((d.getTime() - jan1) / 86_400_000) + 1;
        const week = Math.ceil(dayOfYear / 7);
        return `${d.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
    }
    return d.toISOString().slice(0, 7);            // month default
}

/**
 * Aggregate stats over a channel + time window. Same REST paging loop as
 * `bridgeGetHistory`, but the output is fixed-size (aggregates) regardless of
 * how many messages were scanned — safe for very large windows.
 *
 * `hardCap` (default 50000) bounds how many messages get scanned, in case the
 * window is wider than expected.
 */
async function bridgeGetStats(args = {}) {

    const ChannelStore = need("ChannelStore");
    const SelectedChannelStore = need("SelectedChannelStore");
    const MessageStore = need("MessageStore");

    const channelId = args.channelId || SelectedChannelStore?.getChannelId?.();
    if (!channelId) throw new Error("No channel selected and no channelId provided.");
    const channel = ChannelStore?.getChannel?.(channelId);

    const token = getAuthToken();
    const since = args.since ? isoToSnowflake(args.since) : null;
    const until = args.until ? isoToSnowflake(args.until) : null;
    const groupBy = args.groupBy || "month";
    const topN = Math.max(1, Math.min(100, args.topN ?? 10));
    const hardCap = Math.max(100, Math.min(200_000, args.hardCap ?? 50_000));

    // Page newest→oldest until we cross `since` or hit hardCap.
    const lower = since ? BigInt(since) : null;
    let cursor = until || undefined;
    let scanned = 0;
    let reachedEnd = false;
    let pages = 0;

    let attachments = 0, links = 0, replies = 0;
    const authorCount = new Map();
    const authorName = new Map();
    const bucketCount = new Map();
    const replyEdges = new Map();
    const domains = new Map();
    const words = new Map();
    // Same-window id→authorId map. Replies whose parent author isn't inlined
    // and isn't in MessageStore get resolved against this after paging ends.
    const authorById = new Map();
    const pendingReplies = [];
    let firstTs = null, lastTs = null;

    while (scanned < hardCap) {
        const params = { limit: 100 };
        if (cursor) params.before = cursor;
        const batch = await restFetchMessages(channelId, params, token);
        pages++;
        if (!batch.length) { reachedEnd = true; break; }

        let stop = false;
        for (const m of batch) {
            if (lower && BigInt(m.id) <= lower) { stop = true; break; }
            scanned++;
            const aid = m.author?.id;
            if (aid) {
                authorCount.set(aid, (authorCount.get(aid) || 0) + 1);
                if (!authorName.has(aid)) {
                    authorName.set(aid, m.author.global_name ?? m.author.globalName ?? m.author.username);
                }
                authorById.set(m.id, aid);
            }
            // Also index inlined parent (only set when REST returns it).
            const refAuthor = m.referenced_message?.author;
            if (refAuthor?.id) {
                authorById.set(m.referenced_message.id, refAuthor.id);
                if (!authorName.has(refAuthor.id)) {
                    authorName.set(refAuthor.id, refAuthor.global_name ?? refAuthor.globalName ?? refAuthor.username);
                }
            }
            const ts = m.timestamp || snowflakeToIso(m.id);
            if (ts) {
                if (!firstTs || ts < firstTs) firstTs = ts;
                if (!lastTs || ts > lastTs) lastTs = ts;
                bucketCount.set(bucketOf(ts, groupBy), (bucketCount.get(bucketOf(ts, groupBy)) || 0) + 1);
            }
            if (m.attachments?.length) attachments += m.attachments.length;
            if (m.message_reference?.message_id) {
                replies++;
                const refId = m.message_reference.message_id;
                const refChan = m.message_reference.channel_id || channelId;
                let toId=
                    m.referenced_message?.author?.id ||
                    authorById.get(refId) ||
                    MessageStore?.getMessage?.(refChan, refId)?.author?.id;
                if (aid && toId) {
                    const key = `${aid}→${toId}`;
                    replyEdges.set(key, (replyEdges.get(key) || 0) + 1);
                } else if (aid) {
                    // Parent message hasn't been scanned yet (older page) and
                    // isn't in MessageStore. Resolve after the loop finishes.
                    pendingReplies.push({ from: aid, refId });
                }
            }
            const content = m.content || "";
            const urlMatches = content.match(URL_RE) || [];
            for (const u of urlMatches) {
                links++;
                const dm = u.match(/https?:\/\/([^\s/]+)/i);
                if (dm) {
                    const host = dm[1].replace(/^www\./, "").toLowerCase();
                    domains.set(host, (domains.get(host) || 0) + 1);
                }
            }
            // Strip URLs before tokenizing so URL hosts/path words don't pollute topWords.
            const text = content.replace(/https?:\/\/\S+/gi, " ");
            const wmatches = text.toLowerCase().match(WORD_RE) || [];
            for (const w of wmatches) {
                const norm = stripAccents(w);
                if (STOPWORDS.has(norm)) continue;
                words.set(norm, (words.get(norm) || 0) + 1);
            }
        }
        cursor = batch[batch.length - 1].id;
        if (stop) { reachedEnd = true; break; }
        if (batch.length < 100) { reachedEnd = true; break; }
    }

    // Resolve replies whose parent message was paged in *after* the reply itself.
    for (const { from, refId } of pendingReplies) {
        const toId = authorById.get(refId);
        if (toId) {
            const key = `${from}→${toId}`;
            replyEdges.set(key, (replyEdges.get(key) || 0) + 1);
        }
    }

    const total = scanned;
    const rank =                   (m, n) =>
        [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);

    return {
        channel: channel ? {
            id: channel.id,
            name: channel.name || (channel.recipients?.length ? "(DM)" : null),
            type: channel.type,
            guildId: channel.guild_id || null,
        } : { id: channelId },
        summary: {
            total,
            attachments,
            links,
            replies,
            distinctAuthors: authorCount.size,
            span: { firstTs, lastTs },
            windowSince: args.since || null,
            windowUntil: args.until || null,
            pagesFetched: pages,
            scanComplete: reachedEnd,
            hardCapHit: scanned >= hardCap,
        },
        byAuthor: rank(authorCount, topN).map(([id, count]) => ({
            id,
            name: authorName.get(id) || null,
            count,
            pct: total ? +(count / total * 100).toFixed(1) : 0,
        })),
        byBucket: [...bucketCount.entries()]
            .sort((a, b) => (a[0] < b[0] ? -1 : 1))
            .map(([bucket, count]) => ({ bucket, count })),
        replyEdges: rank(replyEdges, topN).map(([key, count]) => {
            const [from, to] = key.split("→");
            return {
                from, fromName: authorName.get(from) || null,
                to, toName: authorName.get(to) || null,
                count,
            };
        }),
        topDomains: rank(domains, topN).map(([domain, count]) => ({ domain, count })),
        topWords: rank(words, topN).map(([word, count]) => ({ word, count })),
    };
}

/* ----------------------------------------------------- open a channel ---- */

/**
 * Switch Discord to a channel — dispatches the same action the sidebar does
 * (`ChannelActions.selectChannel`). For DMs guildId is null; for guild
 * channels we look it up from ChannelStore so the caller need not provide it.
 * `messageId` scroll-jumps to that message (Discord handles the
 * fetch-around-and-highlight flow).
 */
async function bridgeOpenChannel(args) {

    const ChannelStore = need("ChannelStore");
    const SelectedChannelStore = need("SelectedChannelStore");
    const GuildStore = need("GuildStore");
    const UserStore = need("UserStore");

    const channel = ChannelStore?.getChannel?.(args.channelId);
    if (!channel) throw new Error("Channel not found in ChannelStore: " + args.channelId);

    const guildId = channel.guild_id || null;
    const rendered = await navigate(args.channelId, guildId, args.messageId);

    const guild = guildId ? GuildStore?.getGuild?.(guildId) : null;
    const renderName = (u) => u?.globalName ?? u?.global_name ?? u?.username ?? null;
    const recipientIds = channel.recipients || channel.recipientIds || [];
    const recipients = recipientIds.map(rid => {
        const u = UserStore?.getUser?.(rid);
        return u ? { id: u.id, username: u.username, name: renderName(u) } : { id: rid };
    });

    return {
        ok: rendered,
        ...(rendered ? {} : { note: "Discord didn't show this channel in time, so discord_view won't see its messages. It may have no message list (a forum or voice channel), or still be loading: try again, or use discord_history." }),
        currentChannelId: SelectedChannelStore?.getChannelId?.() ?? null,
        path: location.pathname,
        channel: {
            id: channel.id,
            name: channel.name || (recipients[0]?.name ?? recipients[0]?.username ?? null),
            type: channel.type,
            guildId,
            guildName: guild?.name || null,
            recipients: recipients.length ? recipients : undefined,
        },
        scrolledToMessage: rendered ? args.messageId || null : null,
    };
}

/* --------------------------------------- react / edit / delete / pins -- */

/** Parse "<:name:id>", "<a:name:id>", or raw unicode → emoji descriptor for Discord's reaction API. */
function parseEmoji(input) {
    const m = input.match(/^<(a?):([^:]+):(\d+)>$/);
    if (m) return { name: m[2], id: m[3], animated: !!m[1] };
    const s = input.trim();
    if (!s) throw new Error("Empty emoji.");
    if (/^:[^:]+:$/.test(s))
        throw new Error(
            `Shortcode ${s} not supported — pass raw unicode (e.g. "👍") or the full "<:name:id>" / "<a:name:id>" form.`);
    return { name: s, id: null };
}

/**
 * Add or remove a reaction on a message. Uses Discord's internal
 * `ReactionActions.addReaction` / `removeReaction` — the same code path the
 * reaction picker uses. Pre-validates the messageId against MessageStore so a
 * fabricated ID fails loudly instead of silently no-op-ing.
 */
async function bridgeReact(args) {

    const SelectedChannelStore = need("SelectedChannelStore");
    const ChannelStore = need("ChannelStore");
    const MessageStore = need("MessageStore");
    const UserStore = need("UserStore");

    const channelId = args.channelId || SelectedChannelStore?.getChannelId?.();
    if (!channelId) throw new Error("No channel selected and no channelId provided.");
    if (!args.messageId) throw new Error("`messageId` is required.");
    if (!args.emoji) throw new Error("`emoji` is required.");
    const channel = ChannelStore?.getChannel?.(channelId);
    if (!channel) throw new Error("Channel not found: " + channelId);

    const stored = MessageStore?.getMessage?.(channelId, args.messageId);
    if (!stored)
        throw new Error(
            `messageId ${args.messageId} not found in channel ${channelId}'s local message store. ` +
            "Pull message IDs from a fresh discord_view result for this channel.");

    const emoji = parseEmoji(args.emoji);
    const action = args.action ?? "add";
    if (action !== "add" && action !== "remove")
        throw new Error("`action` must be 'add' or 'remove'.");

    // The reaction action module's property names are minified and change between
    // Discord builds, so we can't rely on findByProps("addReaction", …). Locate the
    // module by the dispatch type strings its functions emit, then identify add vs
    // remove by which dispatch type appears in each function's source.
    const reactionMod = need("ReactionActions");
    if (!reactionMod) throw new Error(
        "Reaction actions module not found — webpack module shape may have changed.");

    // Both add and remove functions reference BOTH dispatch types in their source
    // (error/retry paths), so a simple "contains ADD but not REMOVE" filter fails.
    // Distinguish by which dispatch type appears *first* — that's the one the
    // function actually fires on its happy path.
    let addFn;
    let removeFn;
    for (const v of Object.values(reactionMod)         ) {
        if (typeof v !== "function") continue;
        const src = v.toString();
        const addIdx = src.indexOf('"MESSAGE_REACTION_ADD"');
        const removeIdx = src.indexOf('"MESSAGE_REACTION_REMOVE"');
        if (addIdx < 0 && removeIdx < 0) continue;
        const firesAddFirst = addIdx >= 0 && (removeIdx < 0 || addIdx < removeIdx);
        const firesRemoveFirst = removeIdx >= 0 && (addIdx < 0 || removeIdx < addIdx);
        if (firesAddFirst && !addFn) addFn = v;
        else if (firesRemoveFirst && !removeFn) removeFn = v;
    }
    if (action === "add" && !addFn) throw new Error("Add-reaction function not found in reaction module.");
    if (action === "remove" && !removeFn) throw new Error("Remove-reaction function not found in reaction module.");

    if (action === "add") {
        // Positional signature: (channelId, messageId, emoji, location?, options?)
        await addFn (channelId, args.messageId, emoji);
    } else {
        // Single-object signature: ({channelId, messageId, emoji, location, userId, options})
        const userId = UserStore?.getCurrentUser?.()?.id;
        if (!userId) throw new Error("Could not resolve current user ID for reaction removal.");
        await removeFn ({ channelId, messageId: args.messageId, emoji, location: "Message", userId });
    }

    return {
        ok: true,
        channelId,
        messageId: args.messageId,
        emoji: emoji.id ? `<${emoji.animated ? "a" : ""}:${emoji.name}:${emoji.id}>` : emoji.name,
        action,
    };
}

/** Edit one of the viewer's own messages. Refuses to touch other users' messages. */
async function bridgeEdit(args) {

    const SelectedChannelStore = need("SelectedChannelStore");
    const MessageStore = need("MessageStore");
    const UserStore = need("UserStore");
    const MessageActions = need("MessageActions");

    const channelId = args.channelId || SelectedChannelStore?.getChannelId?.();
    if (!channelId) throw new Error("No channel selected and no channelId provided.");
    if (!args.messageId) throw new Error("`messageId` is required.");
    if (typeof args.content !== "string") throw new Error("`content` is required.");

    const stored = MessageStore?.getMessage?.(channelId, args.messageId);
    if (!stored)
        throw new Error(
            `messageId ${args.messageId} not found in channel ${channelId}'s local message store. ` +
            "Pull message IDs from a fresh discord_view result for this channel.");

    const viewer = UserStore?.getCurrentUser?.();
    if (!viewer) throw new Error("Current user unavailable from UserStore.");
    if (stored.author?.id !== viewer.id)
        throw new Error(
            `Cannot edit message ${args.messageId}: author is ${stored.author?.id} but viewer is ${viewer.id}. ` +
            "Discord only allows editing your own messages.");

    if (!MessageActions?.editMessage)
        throw new Error("MessageActions.editMessage not found — webpack module shape may have changed.");
    await MessageActions.editMessage(channelId, args.messageId, { content: args.content });

    return { ok: true, channelId, messageId: args.messageId, content: args.content };
}

/**
 * Delete one of the viewer's own messages. Author check + pre-validation only —
 * destructive, but the tool description and the model's general "don't delete
 * without explicit instruction" caution carry the rest.
 */
async function bridgeDelete(args) {

    const SelectedChannelStore = need("SelectedChannelStore");
    const MessageStore = need("MessageStore");
    const UserStore = need("UserStore");
    const MessageActions = need("MessageActions");

    const channelId = args.channelId || SelectedChannelStore?.getChannelId?.();
    if (!channelId) throw new Error("No channel selected and no channelId provided.");
    if (!args.messageId) throw new Error("`messageId` is required.");

    const stored = MessageStore?.getMessage?.(channelId, args.messageId);
    if (!stored)
        throw new Error(
            `messageId ${args.messageId} not found in channel ${channelId}'s local message store. ` +
            "Pull message IDs from a fresh discord_view result for this channel.");

    const viewer = UserStore?.getCurrentUser?.();
    if (!viewer) throw new Error("Current user unavailable from UserStore.");
    if (stored.author?.id !== viewer.id)
        throw new Error(
            `Cannot delete message ${args.messageId}: author is ${stored.author?.id} but viewer is ${viewer.id}. ` +
            "Discord only allows deleting your own messages.");

    if (!MessageActions?.deleteMessage)
        throw new Error("MessageActions.deleteMessage not found — webpack module shape may have changed.");
    await MessageActions.deleteMessage(channelId, args.messageId);

    return {
        ok: true,
        channelId,
        messageId: args.messageId,
        deletedContentPreview: (stored.content || "").slice(0, 200),
    };
}

/** List pinned messages in a channel via REST. Pins are usually the channel's thesis — cheap context, huge signal. */
async function bridgePins(args = {}) {

    const ChannelStore = need("ChannelStore");
    const SelectedChannelStore = need("SelectedChannelStore");

    const channelId = args.channelId || SelectedChannelStore?.getChannelId?.();
    if (!channelId) throw new Error("No channel selected and no channelId provided.");
    const channel = ChannelStore?.getChannel?.(channelId);
    const token = getAuthToken();

    const r = await api(`https://discord.com/api/v9/channels/${channelId}/pins`, {
        headers: { authorization: token },
    });
    if (!r.ok) {
        const body = await r.text().catch(() => "");
        throw new Error(`Discord REST /pins error ${r.status}: ${body.slice(0, 300)}`);
    }
    const raw = await r.json();
    const select = new Set        (
        args.select?.length ? args.select : ["id", "content", "author", "timestamp"]
    );

    return {
        channel: channel ? {
            id: channel.id,
            name: channel.name || (channel.recipients?.length ? "(DM)" : null),
            guildId: channel.guild_id || null,
        } : { id: channelId },
        count: raw.length,
        messages: raw.map(m => projectMessage(m, select)),
    };
}

/* ------------------------------------------------------------- threads -- */

/**
 * List threads (active + archived public) under a parent channel. Threads are
 * first-class channels in Discord — the bridge otherwise treats them as
 * invisible. For guild channels, active threads come from the guild-level
 * endpoint and are filtered to this parent.
 */
async function bridgeThreads(args = {}) {

    const ChannelStore = need("ChannelStore");
    const SelectedChannelStore = need("SelectedChannelStore");

    const channelId = args.channelId || SelectedChannelStore?.getChannelId?.();
    if (!channelId) throw new Error("No channel selected and no channelId provided.");
    const channel = ChannelStore?.getChannel?.(channelId);
    const token = getAuthToken();
    const archivedLimit = Math.max(1, Math.min(100, args.archivedLimit ?? 25));

    const projectThread = (t) => ({
        id: t.id,
        name: t.name,
        type: t.type,
        parentId: t.parent_id ?? t.parentId,
        archived: !!(t.thread_metadata?.archived ?? t.threadMetadata?.archived),
        locked: !!(t.thread_metadata?.locked ?? t.threadMetadata?.locked),
        autoArchiveDuration:
            t.thread_metadata?.auto_archive_duration ?? t.threadMetadata?.autoArchiveDuration ?? null,
        archiveTimestamp:
            t.thread_metadata?.archive_timestamp ?? t.threadMetadata?.archiveTimestamp ?? null,
        memberCount: t.member_count ?? t.memberCount ?? null,
        messageCount: t.message_count ?? t.messageCount ?? null,
        ownerId: t.owner_id ?? t.ownerId ?? null,
    });

    // If the supplied channel IS a thread, treat its parent as the listing target.
    const isThread = channel && [10, 11, 12].includes(channel.type);
    const parentForLookup = isThread ? (channel.parent_id || channelId) : channelId;
    const guildId = channel?.guild_id;

    const active = [];
    if (guildId) {
        try {
            const r = await api(`https://discord.com/api/v9/guilds/${guildId}/threads/active`, {
                headers: { authorization: token },
            });
            if (r.ok) {
                const j = await r.json();
                for (const t of j.threads || []) {
                    if ((t.parent_id || t.parentId) === parentForLookup) active.push(projectThread(t));
                }
            }
        } catch { /* */ }
    }

    let archived = [];
    if (args.includeArchived ?? true) {
        try {
            const r = await api(
                `https://discord.com/api/v9/channels/${parentForLookup}/threads/archived/public?limit=${archivedLimit}`,
                { headers: { authorization: token } });
            if (r.ok) {
                const j = await r.json();
                archived = (j.threads || []).map(projectThread);
            }
        } catch { /* */ }
    }

    return {
        channel: channel ? {
            id: channel.id,
            name: channel.name || null,
            type: channel.type,
            guildId: guildId || null,
        } : { id: channelId },
        parentId: parentForLookup,
        activeCount: active.length,
        archivedCount: archived.length,
        threads: { active, archived },
    };
}

/* ---------------------------------------------- member / user profile -- */

/**
 * Lookup a user's full profile: REST `/users/{id}/profile` for bio/pronouns/
 * mutual guilds, PresenceStore for status + activities. Useful for
 * disambiguation ("which Ana?"), tone calibration, and addressing by
 * `globalName` instead of username.
 */
async function bridgeMember(args) {
    if (!args.userId) throw new Error("`userId` is required.");

    const UserStore = need("UserStore");
    const PresenceStore = need("PresenceStore");

    const token = getAuthToken();
    let profile = null;
    try {
        const r = await api(
            `https://discord.com/api/v9/users/${args.userId}/profile?with_mutual_guilds=true`,
            { headers: { authorization: token } });
        if (r.ok) profile = await r.json();
        else if (r.status === 404) throw new Error("User not found: " + args.userId);
        else if (r.status === 403) {
            // Some users (e.g. via DM-blocked) return 403 — fall through to UserStore.
        }
    } catch (e) {
        if (typeof e?.message === "string" && e.message.startsWith("User not found")) throw e;
        // network error — fall through
    }

    const u = profile?.user ?? UserStore?.getUser?.(args.userId);
    if (!u)
        throw new Error(
            "User not found via profile API or UserStore: " + args.userId +
            ". The user may not share any context with you.");

    const renderName = (x) => x?.global_name ?? x?.globalName ?? x?.username ?? null;
    const avatarUrl = u.avatar
        ? `https://cdn.discordapp.com/avatars/${u.id}/${u.avatar}.${u.avatar.startsWith("a_") ? "gif" : "png"}?size=256`
        : null;
    const createdAtMs = Number((BigInt(u.id) >> 22n) + DISCORD_EPOCH);

    const status = PresenceStore?.getStatus?.(args.userId) || null;
    const activities = (PresenceStore?.getActivities?.(args.userId) || []).map((a) => ({
        name: a.name,
        type: a.type,
        state: a.state,
        details: a.details,
        applicationId: a.application_id ?? a.applicationId,
    }));
    const mutualGuilds = (profile?.mutual_guilds || []).map(
        (g) => ({ id: g.id, nick: g.nick || null }));

    return {
        id: u.id,
        username: u.username,
        globalName: renderName(u),
        discriminator: u.discriminator && u.discriminator !== "0" ? u.discriminator : undefined,
        avatarUrl,
        bot: !!u.bot,
        createdAt: new Date(createdAtMs).toISOString(),
        bio: profile?.user_profile?.bio || null,
        pronouns: profile?.user_profile?.pronouns || null,
        accentColor: profile?.user_profile?.accent_color ?? null,
        status,
        activities,
        mutualGuilds,
        mutualGuildCount: mutualGuilds.length,
    };
}

/* ------------------------------------------------------- unread / ack --- */

/**
 * Enumerate channels with unread messages. Walks DMs (always) and guild text
 * channels (when `includeGuilds`). For each, asks ReadStateStore for unread
 * count + mention count + oldest unread id.
 */
/** Between the per-channel requests of discord_unread. */
const COUNT_GAP_MS = 300;

async function bridgeUnread(args = {}) {

    const ChannelStore = need("ChannelStore");
    const ReadStateStore = need("ReadStateStore");
    const SortStore = need("PrivateChannelSortStore");
    const GuildStore = need("GuildStore");
    const GuildChannelStore = need("GuildChannelStore");
    const UserStore = need("UserStore");
    const RelationshipStore = need("RelationshipStore");

    if (!ReadStateStore) throw new Error("ReadStateStore not found.");

    const renderName = (u) => u?.globalName ?? u?.global_name ?? u?.username ?? null;
    const limit = Math.max(1, Math.min(500, args.limit ?? 100));
    const mentionsOnly = !!args.mentionsOnly;
    // Counting asks Discord once a channel, so only the ones at the top of the list.
    const countTop = Math.max(0, Math.min(25, args.countTop ?? 10));

    const channelIds = [];
    if (typeof SortStore?.getPrivateChannelIds === "function") {
        channelIds.push(...SortStore.getPrivateChannelIds());
    } else if (typeof ChannelStore?.getSortedPrivateChannels === "function") {
        channelIds.push(...ChannelStore.getSortedPrivateChannels().map((c) => c.id));
    }

    if (args.includeGuilds && GuildStore && GuildChannelStore?.getChannels) {
        for (const gid of Object.keys(GuildStore.getGuilds() || {})) {
            const groups = GuildChannelStore.getChannels(gid);
            const selectable = groups?.SELECTABLE || groups?.selectable || [];
            for (const entry of selectable) {
                const ch = entry.channel || entry;
                if (ch?.id) channelIds.push(ch.id);
            }
        }
    }

    const out = [];
    let totalMentions = 0;
    for (const cid of channelIds) {
        const mentions = ReadStateStore.getMentionCount?.(cid) || 0;
        // Discord counts unread messages from the ones it has in memory: 0 for a channel not
        // opened yet, whatever is there, and too low for one partly loaded.
        const unread = ReadStateStore.getUnreadCount?.(cid) || 0;
        const has = ReadStateStore.hasUnread?.(cid);
        if (!unread && !mentions && !has) continue;
        if (mentionsOnly && !mentions) continue;
        totalMentions += mentions;
        const ch = ChannelStore?.getChannel?.(cid);
        const oldest = ReadStateStore.getOldestUnreadMessageId?.(cid) || null;
        const lastRead = ReadStateStore.ackMessageId?.(cid) || null;
        const isDm = ch && (ch.type === 1 || ch.type === 3);
        let name = ch?.name || null;
        if (isDm) {
            const recipientIds = ch.recipients || ch.recipientIds || [];
            const first = recipientIds[0];
            const u = first ? UserStore?.getUser?.(first) : null;
            const nick = first ? RelationshipStore?.getNickname?.(first) : null;
            if (ch.type === 1) name = nick || renderName(u) || "(dm)";
            else name = ch.name || (recipientIds.map(id => {
                const cu = UserStore?.getUser?.(id);
                return RelationshipStore?.getNickname?.(id) || renderName(cu);
            }).filter(Boolean).join(", ") || "(group)");
        }
        out.push({
            channelId: cid,
            kind: ch?.type === 1 ? "dm" : ch?.type === 3 ? "group" : "guild",
            name,
            guildId: ch?.guild_id || null,
            guildName: ch?.guild_id ? GuildStore?.getGuild?.(ch.guild_id)?.name ?? null : null,
            unreadCount: has ? null : unread,
            memoryCount: unread,
            mentionCount: mentions,
            oldestUnreadId: oldest,
            lastReadMessageId: lastRead,
            lastMessageId: ReadStateStore.lastMessageId?.(cid) || null,
        });
    }

    const newest = (a, b) => (BigInt(b.lastMessageId ?? 0) > BigInt(a.lastMessageId ?? 0) ? 1 : -1);
    out.sort((a, b) => (b.mentionCount - a.mentionCount) || (b.memoryCount - a.memoryCount) || newest(a, b));
    const shown = out.slice(0, limit);

    // The rest of the truth comes from the messages themselves.
    const token = getAuthToken();
    let asked = 0;
    for (const c of shown) {
        if (c.unreadCount !== null) continue;
        if (asked >= countTop) break;
        if (asked++) await sleep(COUNT_GAP_MS);
        try {
            const msgs = await restFetchMessages(c.channelId, { after: c.lastReadMessageId ?? undefined, limit: 100 }, token);
            c.unreadCount = msgs.length;
            if (msgs.length >= 100) c.unreadCountAtLeast = true;
            c.oldestUnreadId = msgs.at(-1)?.id ?? c.oldestUnreadId;
        } catch { /* stays unknown: the channel may not be readable */ }
    }
    // What's left is all Discord knows: at least that many, or unknown.
    for (const c of out) {
        if (c.unreadCount === null && c.memoryCount > 0) {
            c.unreadCount = c.memoryCount;
            c.unreadCountAtLeast = true;
            c.notCounted = true;
        } else if (c.unreadCount === null) c.notCounted = true;
        delete c.memoryCount;
    }
    return {
        channelsScanned: channelIds.length,
        totalUnread: out.reduce((n, c) => n + (c.unreadCount ?? 0), 0),
        // Channels with unread messages that aren't in totalUnread.
        channelsNotCounted: out.filter(c => c.notCounted).length,
        totalMentions,
        count: out.length,
        channels: shown,
    };
}

/**
 * Mark a channel read up to a given message. REST:
 * `POST /channels/{id}/messages/{messageId}/ack` with `{ token: null, manual: true }`.
 * If `messageId` omitted, acks the channel's most recent message.
 */
async function bridgeAck(args) {
    if (!args.channelId) throw new Error("`channelId` is required.");

    const ChannelStore = need("ChannelStore");
    const ReadStateStore = need("ReadStateStore");
    const MessageStore = need("MessageStore");

    const token = getAuthToken();

    let mid = args.messageId;
    if (!mid) {
        const msgs = MessageStore?.getMessages?.(args.channelId);
        const last = msgs?._array?.[msgs._array.length - 1]
            ?? msgs?.toArray?.()?.slice(-1)[0]
            ?? null;
        mid = last?.id || ReadStateStore?.lastMessageId?.(args.channelId);
        if (!mid) {
            // REST fallback — fetch the newest message id.
            const batch = await restFetchMessages(args.channelId, { limit: 1 }, token);
            mid = batch[0]?.id;
        }
    }
    if (!mid) throw new Error("Could not determine a messageId to ack (channel may be empty).");

    const r = await api(
        `https://discord.com/api/v9/channels/${args.channelId}/messages/${mid}/ack`,
        {
            method: "POST",
            headers: { authorization: token, "content-type": "application/json" },
            body: JSON.stringify({ token: null, manual: true }),
        });
    if (!r.ok) {
        const text = await r.text().catch(() => "");
        throw new Error(`Discord REST /ack error ${r.status}: ${text.slice(0, 300)}`);
    }
    const ch = ChannelStore?.getChannel?.(args.channelId);
    return {
        ok: true,
        channelId: args.channelId,
        ackedMessageId: mid,
        channel: ch ? {
            id: ch.id,
            name: ch.name || null,
            guildId: ch.guild_id || null,
        } : null,
    };
}

/* ------------------------------------------------------- emoji ---------- */

/**
 * List/search custom server emoji across the user's guilds. Returns each as
 * `{ shortcode }` ready to paste into `discord_send` content or use directly
 * with `discord_react`'s `<:name:id>` form.
 */
function bridgeEmoji(args = {}) {

    const EmojiStore = need("EmojiStore");
    const GuildStore = need("GuildStore");

    if (!EmojiStore) throw new Error("EmojiStore not found — webpack module shape may have changed.");

    let guildsMap = {};
    if (typeof EmojiStore.getGuilds === "function") {
        guildsMap = EmojiStore.getGuilds() || {};
    } else if (typeof EmojiStore.getGuildEmoji === "function" && typeof GuildStore?.getGuilds === "function") {
        for (const gid of Object.keys(GuildStore.getGuilds())) {
            const emojis = EmojiStore.getGuildEmoji(gid);
            if (emojis?.length) guildsMap[gid] = { emojis };
        }
    } else {
        throw new Error("EmojiStore has no recognized listing method.");
    }

    const q = (args.query || "").trim().toLowerCase();
    const limit = Math.max(1, Math.min(200, args.limit ?? 25));

    const score = (name) => {
        if (!q) return 0;
        const lo = name.toLowerCase();
        if (lo === q) return 100;
        if (lo.startsWith(q)) return 75;
        if (lo.includes(q)) return 50;
        return -1;
    };

    const out = [];
    for (const [gid, g] of Object.entries(guildsMap)) {
        if (args.guildId && gid !== args.guildId) continue;
        const guildName = GuildStore?.getGuild?.(gid)?.name ?? null;
        for (const e of (g).emojis || []) {
            const s = score(e.name);
            if (q && s < 0) continue;
            out.push({
                name: e.name,
                id: e.id,
                animated: !!e.animated,
                guildId: gid,
                guildName,
                url: `https://cdn.discordapp.com/emojis/${e.id}.${e.animated ? "gif" : "png"}?size=96`,
                shortcode: `<${e.animated ? "a" : ""}:${e.name}:${e.id}>`,
                _score: s,
            });
        }
    }

    out.sort((a, b) => b._score - a._score || a.name.localeCompare(b.name));
    return {
        total: out.length,
        query: q || undefined,
        emojis: out.slice(0, limit).map(({ _score, ...rest }) => rest),
    };
}

/* ------------------------------------------------------- dm open --------- */

/**
 * Start a DM (or group DM) with a user not yet in the sidebar.
 * REST: `POST /users/@me/channels` with `{ recipient_id }` or `{ recipients: [] }`.
 * Returns the channel info in the same shape as `discord_dms` so the result
 * pipes straight into `discord_send`.
 */
async function bridgeDmOpen(args) {

    const ids = args.userIds?.length ? args.userIds : (args.userId ? [args.userId] : []);
    if (!ids.length) throw new Error("Provide `userId` or `userIds`.");

    // A DM that doesn't exist yet is what the spam filter watches; the host paces those.
    const existing = ids.length === 1 ? need("ChannelStore")?.getDMFromUserId?.(ids[0]) : null;
    if (!existing && args._allowNew === false) return { paced: true };

    const token = getAuthToken();
    const body = ids.length === 1
        ? { recipient_id: ids[0] }
        : { recipients: ids };

    const r = await api("https://discord.com/api/v9/users/@me/channels", {
        method: "POST",
        headers: { authorization: token, "content-type": "application/json" },
        body: JSON.stringify(body),
    });
    if (!r.ok) {
        const text = await r.text().catch(() => "");
        throw new Error(`Discord REST /users/@me/channels error ${r.status}: ${text.slice(0, 300)}`);
    }
    const ch = await r.json();

    const UserStore = need("UserStore");
    const RelationshipStore = need("RelationshipStore");
    const renderName = (u) => u?.global_name ?? u?.globalName ?? u?.username ?? null;

    // Resolving the channel via REST is not enough — the agent's mental model
    // of `dmOpen` is "navigate to this DM". Do it here so the name matches the
    // behavior, and say whether it made it onto the page.
    const rendered = await navigate(ch.id, null);

    const recipients = (ch.recipients || []).map((u) => {
        const cached = UserStore?.getUser?.(u.id);
        const nickname = RelationshipStore?.getNickname?.(u.id) || null;
        return {
            id: u.id,
            username: u.username || cached?.username,
            name: renderName(u) || renderName(cached),
            nickname,
            bot: !!(u.bot ?? cached?.bot),
        };
    });
    const isGroup = ch.type === 3;
    const name = isGroup
        ? (ch.name || recipients.map((r) => r.nickname || r.name || r.username).filter(Boolean).join(", ") || "(group)")
        : (recipients[0]?.nickname || recipients[0]?.name || recipients[0]?.username || "(unknown)");

    return {
        channelId: ch.id,
        kind: isGroup ? "group" : "dm",
        name,
        memberCount: isGroup ? recipients.length : undefined,
        recipients,
        rendered,
        created: !existing,
    };
}

/* ------------------------------------------------------- attachment ------ */

/**
 * Return attachment metadata for a message. The MCP server does the actual
 * CDN fetch — keeps the bytes off the /eval payload (which is capped at 600 KB
 * for sanity). Discord's CDN URLs are signed (`ex`/`is`/`hm` query params) and
 * work from anywhere — no auth needed on the host's side.
 */
async function bridgeAttachment(args) {

    const SelectedChannelStore = need("SelectedChannelStore");
    const MessageStore = need("MessageStore");

    const channelId = args.channelId || SelectedChannelStore?.getChannelId?.();
    if (!channelId) throw new Error("No channel selected and no channelId provided.");
    if (!args.messageId) throw new Error("`messageId` is required.");

    const token = getAuthToken();
    const msg = await fetchMessageById(channelId, args.messageId, token);
    if (!msg)
        throw new Error(`messageId ${args.messageId} not found in channel ${channelId}.`);

    const attachments = msg.attachments || [];
    if (!attachments.length)
        throw new Error(`message ${args.messageId} has no attachments.`);

    const idx = Math.max(0, Math.min(attachments.length - 1, args.index ?? 0));
    const a = attachments[idx];
    return {
        index: idx,
        attachmentCount: attachments.length,
        name: a.filename || a.name,
        url: a.url,
        proxyUrl: a.proxy_url || a.proxyUrl || null,
        size: a.size,
        contentType: a.content_type || a.contentType || null,
        width: a.width ?? null,
        height: a.height ?? null,
    };
}

/* ----------------------- reply-chain walker + resolveMessage --------------- */

const renderUserName = (u) => u?.global_name ?? u?.globalName ?? u?.username ?? null;

function compactMessage(msg) {
    const tsIso = (t) =>
        typeof t?.toISOString === "function" ? t.toISOString() : (t ? String(t) : null);
    return {
        id: msg.id,
        timestamp: tsIso(msg.timestamp) ?? msg.timestamp ?? null,
        author: msg.author ? {
            id: msg.author.id,
            username: msg.author.username,
            name: renderUserName(msg.author),
            bot: !!msg.author.bot,
        } : null,
        content: (msg.content || "").slice(0, 800),
    };
}

async function fetchMessageById(channelId, messageId, token) {
    const MessageStore = need("MessageStore");
    const cached = MessageStore?.getMessage?.(channelId, messageId);
    if (cached) return cached;
    try {
        const batch = await restFetchMessages(channelId, { limit: 1, around: messageId }, token);
        return batch.find((m) => m.id === messageId) || null;
    } catch { return null; }
}

/** Walk a reply chain N parents starting at messageId. Returns oldest→newest. */
async function walkReplyChain(
    channelId, messageId, depth, token
) {
    const chain = [];
    let nextChan = channelId;
    let nextId = messageId;
    const seen = new Set();
    for (let i = 0; i < depth && nextId; i++) {
        const key = nextChan + "/" + nextId;
        if (seen.has(key)) break;
        seen.add(key);
        const msg = await fetchMessageById(nextChan, nextId, token);
        if (!msg) { chain.push({ id: nextId, unloaded: true }); break; }
        chain.push(compactMessage(msg));
        const ref = msg.messageReference || msg.message_reference;
        if (!ref?.message_id) break;
        nextChan = ref.channel_id || nextChan;
        nextId = ref.message_id;
    }
    return chain.reverse();
}

/** Fetch one message + its parent chain (depth N). Useful when a `replyTo.id` from another tool is unresolved. */
async function bridgeResolveMessage(args) {

    const SelectedChannelStore = need("SelectedChannelStore");
    const ChannelStore = need("ChannelStore");

    const channelId = args.channelId || SelectedChannelStore?.getChannelId?.();
    if (!channelId) throw new Error("No channel selected and no channelId provided.");
    if (!args.messageId) throw new Error("`messageId` is required.");

    const token = getAuthToken();
    const msg = await fetchMessageById(channelId, args.messageId, token);
    if (!msg) throw new Error(`messageId ${args.messageId} not found in channel ${channelId}.`);

    const depth = Math.max(0, Math.min(20, args.depth ?? 5));
    const ref = msg.messageReference || msg.message_reference;
    const chain = ref?.message_id
        ? await walkReplyChain(ref.channel_id || channelId, ref.message_id, depth, token)
        : [];

    const channel = ChannelStore?.getChannel?.(channelId);
    const projectKeys = new Set(["id", "content", "author", "timestamp", "attachments", "replyTo", "mentions", "reactions", "edited"]);
    return {
        channel: channel ? {
            id: channel.id,
            name: channel.name || (channel.recipients?.length ? "(DM)" : null),
            guildId: channel.guild_id || null,
        } : { id: channelId },
        message: projectMessage(msg, projectKeys),
        replyChain: chain,
    };
}

/* ----------------------------------------------- guild folder organize -- */

/** Locate the PreloadedUserSettings proto-actions module (type === 1). */
function getPreloadedUserSettings() {
    const preloaded = need("PreloadedUserSettings");
    if (!preloaded) throw new Error("PreloadedUserSettings proto-actions module not found.");
    return preloaded;
}

/** Read the current sidebar layout — folders + top-level guilds, in order. */
function bridgeListGuilds() {

    const GuildStore = need("GuildStore");
    const SortedGuildStore = need("SortedGuildStore");
    const allGuildsMap = GuildStore?.getGuilds?.() ?? {};
    const folders = SortedGuildStore?.getGuildFolders?.() ?? [];

    // SortedGuildStore exposes flat entries: a "folder with no folderId/name"
    // is a top-level single guild; everything else is a real folder.
    const sidebar = folders.map(f => {
        const isFolder = f.folderId != null;
        if (isFolder) {
            return {
                kind: "folder"         ,
                id: String(f.folderId),
                name: f.folderName ?? "",
                color: f.folderColor ?? null,
                expanded: f.expanded !== false,
                guildIds: [...(f.guildIds ?? [])],
                guilds: (f.guildIds ?? []).map((gid) => ({
                    id: gid,
                    name: allGuildsMap[gid]?.name ?? null,
                })),
            };
        }
        const gid = f.guildIds?.[0];
        return {
            kind: "guild"         ,
            guildId: gid,
            name: gid ? (allGuildsMap[gid]?.name ?? null) : null,
        };
    });

    // Cover any guilds the user is in but not listed (defensive — shouldn't happen)
    const referenced = new Set();
    for (const f of folders) for (const id of (f.guildIds ?? [])) referenced.add(id);
    const orphans = Object.keys(allGuildsMap).filter(id => !referenced.has(id));

    return {
        totalGuilds: Object.keys(allGuildsMap).length,
        entries: sidebar.length,
        sidebar,
        orphans: orphans.length ? orphans.map(id => ({ id, name: allGuildsMap[id]?.name })) : undefined,
    };
}

/**
 * Apply a new sidebar layout. `args.sidebar` is the full ordered list of
 * top-level entries: each entry is either a single guild (`{guildId}`) or a
 * folder (`{guildIds, name?, color?, id?}`). Every guild the user is in must
 * appear exactly once across all entries.
 *
 * Default is dry-run: returns the diff without writing. Pass `apply: true` to
 * commit the change via `PreloadedUserSettings.updateAsync("guildFolders", ...)`.
 *
 * Folder field shape (from the proto):
 *   - `id`:    google.protobuf.Int64Value   → `{ value: BigInt }`
 *   - `name`:  google.protobuf.StringValue  → `{ value: string }`
 *   - `color`: google.protobuf.UInt64Value  → `{ value: BigInt }`
 * Bare top-level guilds are written as `{ guildIds: [id] }` only.
 */
async function bridgeOrganizeGuilds(args) {
    if (!args || !Array.isArray(args.sidebar))
        throw new Error("Expected `sidebar: SidebarEntry[]`.");

    const GuildStore = need("GuildStore");
    const allGuildsMap = GuildStore?.getGuilds?.() ?? {};
    const knownGuildIds = new Set(Object.keys(allGuildsMap));

    const seen = new Set();

    const built = [];
    const errors = [];

    for (let i = 0; i < args.sidebar.length; i++) {
        const e = args.sidebar[i];
        const kind = e.kind ?? (e.guildIds != null ? "folder" : "guild");
        if (kind === "guild") {
            const gid = e.guildId ?? (e.guildIds && e.guildIds[0]);
            if (!gid) { errors.push(`entries[${i}]: missing guildId`); continue; }
            if (!knownGuildIds.has(gid)) { errors.push(`entries[${i}]: unknown guildId ${gid}`); continue; }
            if (seen.has(gid)) { errors.push(`entries[${i}]: duplicate guildId ${gid}`); continue; }
            seen.add(gid);
            built.push({ kind: "guild", guildIds: [gid] });
        } else {
            const gids = e.guildIds ?? [];
            if (!gids.length) { errors.push(`entries[${i}]: folder must have ≥1 guildIds`); continue; }
            const folder = { kind: "folder", guildIds: [] };
            for (const gid of gids) {
                if (!knownGuildIds.has(gid)) { errors.push(`entries[${i}]: unknown guildId ${gid}`); continue; }
                if (seen.has(gid)) { errors.push(`entries[${i}]: duplicate guildId ${gid}`); continue; }
                seen.add(gid);
                folder.guildIds.push(gid);
            }
            if (!folder.guildIds.length) continue;
            // Folder identity: an `id` value lets Discord track the folder across
            // edits (expanded/collapsed state, etc.). Auto-mint one if missing.
            try { folder.id = e.id != null ? BigInt(e.id) : BigInt(Date.now()) * 1000n + BigInt(i); }
            catch { errors.push(`entries[${i}]: bad folder id ${e.id}`); }
            if (e.name != null) folder.name = String(e.name);
            if (e.color != null) {
                try { folder.color = BigInt(e.color); }
                catch { errors.push(`entries[${i}]: bad folder color ${e.color}`); }
            }
            built.push(folder);
        }
    }

    const missing = [...knownGuildIds].filter(g => !seen.has(g));
    if (missing.length)
        errors.push(`missing guilds (must appear exactly once): ${missing.slice(0, 8).join(", ")}` +
            (missing.length > 8 ? ` … (+${missing.length - 8})` : ""));

    // Build the diff snapshot (resolved names) for the caller.
    const resolvedPreview = built.map(b => {
        if (b.kind === "guild") {
            const gid = b.guildIds[0];
            return { kind: "guild", guildId: gid, name: allGuildsMap[gid]?.name ?? null };
        }
        return {
            kind: "folder",
            id: String(b.id),
            name: b.name ?? "",
            color: b.color != null ? String(b.color) : null,
            guildIds: b.guildIds,
            guilds: b.guildIds.map(gid => ({ id: gid, name: allGuildsMap[gid]?.name ?? null })),
        };
    });

    if (errors.length) {
        return { applied: false, errors, preview: resolvedPreview };
    }

    if (!args.apply) {
        return {
            applied: false,
            dryRun: true,
            note: "Dry run — no changes applied. Pass `apply: true` to commit.",
            preview: resolvedPreview,
        };
    }

    // Translate to the proto shape and write.
    const protoFolders = built.map(b => {
        if (b.kind === "guild") return { guildIds: b.guildIds };
        const out = { guildIds: b.guildIds };
        if (b.id != null) out.id = { value: b.id };
        if (b.name != null) out.name = { value: b.name };
        if (b.color != null) out.color = { value: b.color };
        return out;
    });

    const preloaded = getPreloadedUserSettings();
    await preloaded.updateAsync("guildFolders",
        (proto) => { proto.folders = protoFolders; },
        0,
        () => {},
    );

    return {
        applied: true,
        entries: protoFolders.length,
        layout: resolvedPreview,
    };
}

/* ------------------------------------------------------------ join invite -- */

/** Pull the invite code out of any of the forms a user might paste. */
function parseInviteCode(raw) {
    let s = String(raw ?? "").trim();
    if (!s) throw new Error("Empty invite — pass an invite URL or code.");
    // Strip a leading scheme so URL() isn't required, then peel the code.
    const m = s.match(/(?:discord\.gg|discord(?:app)?\.com\/invite|invite)\/([^/?#\s]+)/i);
    if (m) s = m[1];
    // Drop any leftover query/hash/path on a bare code.
    s = s.split(/[?#/]/)[0].trim();
    if (!s) throw new Error(`Could not parse an invite code from: ${raw}`);
    return s;
}

/**
 * Resolve a Discord invite and (optionally) join the guild behind it.
 *
 * Dry-run by default: resolves the invite and reports the guild/channel it
 * points at without joining. Pass `apply: true` to actually accept the invite
 * via `InviteActions.acceptInvite`. Idempotent — if the user is already in the
 * target guild, returns `alreadyMember: true` without re-accepting.
 */
async function bridgeJoinInvite(args) {

    const code = parseInviteCode(args?.invite);
    const InviteActions = need("InviteActions");
    if (!InviteActions?.resolveInvite || !InviteActions?.acceptInvite)
        throw new Error("InviteActions module not found — webpack module shape may have changed.");
    const GuildStore = need("GuildStore");

    const resolved = await InviteActions.resolveInvite(code, "Join Guild");
    const invite = resolved?.invite;
    if (!invite)
        return { joined: false, code, error: "Invite is invalid, expired, or revoked." };

    const guild = invite.guild ?? null;
    const preview = {
        code,
        guild: guild ? { id: guild.id, name: guild.name } : null,
        channel: invite.channel ? { id: invite.channel.id, name: invite.channel.name } : null,
        approxMembers: invite.approximate_member_count ?? null,
        approxOnline: invite.approximate_presence_count ?? null,
        inviter: invite.inviter ? { id: invite.inviter.id, username: invite.inviter.username } : null,
    };

    // Already a member? Don't re-accept — just report it.
    if (guild && GuildStore?.getGuild?.(guild.id))
        return { joined: false, alreadyMember: true, ...preview };

    if (!args?.apply)
        return {
            joined: false,
            dryRun: true,
            note: "Dry run — invite resolved but not joined. Pass `apply: true` to join.",
            ...preview,
        };

    // Accept the invite. acceptInvite reads `context.invite_instance_id`, so the
    // context object must exist; `location` mirrors a normal in-app join.
    // IMPORTANT: do NOT await this. Discord gates joins on large/flagged guilds
    // behind a cross-origin hCaptcha iframe, and acceptInvite's promise then
    // stays pending until a human solves the captcha — awaiting it here would
    // wedge the whole eval past the 15s plugin budget. Fire it, stash the
    // outcome, and poll the store for a bounded window instead.
    const targetId = guild?.id;
    let acceptError = null;
    InviteActions.acceptInvite({ inviteKey: code, context: { location: "Join Guild" } })
        .catch((e) => { acceptError = String(e?.message || e); });

    // Poll the store for ~6s (within the 15s eval budget). A captcha-gated join
    // won't land in this window — we detect that by the hCaptcha iframe and
    // report it cleanly.
    let memberNow = false;
    for (let i = 0; i < 30; i++) {
        if (targetId && GuildStore?.getGuild?.(targetId)) { memberNow = true; break; }
        if (acceptError) break;
        await new Promise(r => setTimeout(r, 200));
    }

    const captchaUp = !memberNow && isCaptchaShowing();

    if (memberNow) return { joined: true, ...preview };
    if (captchaUp) return {
        joined: false,
        captchaRequired: true,
        ...preview,
        note: "Discord wants a captcha for this join, and a person has to solve it. Ask the user to " +
            "join this server from their own Discord app; don't retry.",
    };
    if (acceptError) return { joined: false, error: acceptError, ...preview };
    return {
        joined: false,
        ...preview,
        note: "Invite accepted but guild not yet visible — it may still be loading, or " +
            "onboarding/rules may be gating entry. Re-check membership shortly.",
    };
}

/** True while a captcha challenge iframe is mounted in the renderer. */
function isCaptchaShowing() {
    return !!document.querySelector('iframe[src*="hcaptcha.com"], iframe[src*="captcha"]');
}

/**
 * Discord server onboarding auto-completer — runs INSIDE the Vencord renderer.
 *
 *  * Flow handled:
 *   1. "Question X of Y" questionnaire — required questions get the first option
 *      selected then Next; optional questions are Skipped (unless opts.answerOptional).
 *      Two answer widgets exist: the option-button grid (`optionButtonWrapper`) and
 *      a "Select..." dropdown (a combobox input whose listbox renders in a portal);
 *      the dropdown is expanded first, then its first `[role="option"]` is clicked.
 *   2. "One last step! Read & Agree to Server Rules" — the final gate Discord shows
 *      after the questionnaire. Has no "Question X of Y" heading, so it's detected
 *      separately and completed by clicking the Finish button.
 *
 * Scoped to the current server's onboarding unless opts.allServers is set (Discord
 * chains the onboarding of several freshly-joined servers back-to-back).
 *
 * Keep this dependency-free and resilient to Discord's hashed CSS class names
 * (match by stable substrings like `optionButtonWrapper`, never exact hashes).
 */
async function walkOnboarding(opts) {
    opts = opts || {};
    const ANSWER_OPTIONAL = !!opts.answerOptional;
    const ALL_SERVERS = !!opts.allServers;
    const MAX_Q = Math.max(1, Math.min(100, opts.maxQuestions || 40));

    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const log = [];

    // Stop before the caller's renderer timeout kills the eval: `log` only exists
    // here, so a walk that overruns would return nothing at all.
    const deadline = Date.now() + Math.max(10000, Math.min(280000, opts.budgetMs || 105000));
    const outOfTime = () => Date.now() > deadline;

    // The guild whose onboarding we're on, from /channels/<id>/onboarding.
    const guildOf = () => {
        const m = location.pathname.match(/\/channels\/(\d+)\/onboarding/);
        return m ? m[1] : null;
    };

    // Dispatch a faithful pointer+mouse+click burst on an element. React's
    // delegated onClick fires only for handlers on the event target's ancestor
    // chain, so we must hit the deepest painted node — not a layout wrapper.
    const fire = (el) => {
        if (!el) return false;
        const r = el.getBoundingClientRect();
        const init = {
            bubbles: true, cancelable: true, view: window, button: 0,
            clientX: Math.round(r.left + r.width / 2),
            clientY: Math.round(r.top + r.height / 2),
        };
        for (const t of ["pointerover", "pointerenter", "pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
            const Ctor = t.startsWith("pointer") ? (window.PointerEvent || MouseEvent) : MouseEvent;
            try { el.dispatchEvent(new Ctor(t, init)); } catch (e) { /* ignore */ }
        }
        return true;
    };

    // The bottom-right advance button. Reads "Skip" until a selection is made,
    // then morphs to "Next"/"Continue"/etc. Picks the visible button with the
    // lowest screen position to avoid stray matches outside the onboarding overlay.
    const advBtn = () => {
        const vw = window.innerWidth, vh = window.innerHeight;
        let adv = null, adv_y = -1;
        for (const el of document.querySelectorAll('button,[role="button"]')) {
            const t = (el.textContent || "").trim();
            if (!/^(Skip|Next|Continue|Done|Submit|Finish)\b/i.test(t)) continue;
            const r = el.getBoundingClientRect();
            if (r.width === 0 || r.height === 0 || r.bottom < 0 || r.top > vh || r.right < 0 || r.left > vw) continue;
            if (r.bottom > adv_y) { adv = el; adv_y = r.bottom; }
        }
        return adv;
    };
    const advText = () => { const a = advBtn(); return a ? (a.textContent || "").trim() : null; };

    // advBtn() matches `[role="button"]` too, and a div carries its disabled
    // state as aria-disabled — `.disabled` is undefined there.
    const isDisabled = (el) => !!el && (el.disabled === true ||
        el.hasAttribute("disabled") || el.getAttribute("aria-disabled") === "true");

    // Detect the "One last step! Read & Agree to Server Rules" screen.
    // It appears after the Q&A flow but has no "Question X of Y" heading.
    const rulesScreen = () =>
        !!guildOf() && /Read\s*&\s*Agree/i.test(document.body ? document.body.textContent || "" : "");

    // Leaf element holding some onboarding caption, e.g. "Question 1 of 3".
    // The element pass catches a caption Discord split across several nodes,
    // which the text-node walk alone would miss.
    const captionEl = (re) => {
        const walker = document.createTreeWalker(document.body || document, NodeFilter.SHOW_TEXT);
        let node;
        while ((node = walker.nextNode())) {
            if (re.test((node.textContent || "").trim())) return node.parentElement;
        }
        // Onboarding always renders in the modal, so the split-caption scan stays
        // inside it — the whole-body scan only runs when no dialog is mounted.
        const dialog = document.querySelector('[role="dialog"]');
        let deepest = null;
        for (const el of (dialog || document.body || document).querySelectorAll("*")) {
            if (!re.test((el.textContent || "").trim())) continue;
            if (!deepest || deepest.contains(el)) deepest = el;
        }
        return deepest;
    };

    // The overlay a caption sits in: Discord renders onboarding in a modal, so
    // prefer its dialog ancestor and fall back to the nearest ancestor holding
    // `sel`, capped so a screen without one cannot resolve to <body>.
    const scopeAround = (from, sel) => {
        const dialog = from && from.closest('[role="dialog"]');
        if (dialog && dialog.querySelector(sel)) return dialog;
        for (let el = from, i = 0; el && i < 10; i++, el = el.parentElement)
            if (el.querySelector(sel)) return el;
        return null;
    };

    // Scoped to the rules overlay: a synthetic `scroll` on the message list
    // behind it would drive Discord's history pagination and read state.
    const scrollStep = () => {
        const root = scopeAround(captionEl(/Read\s*&\s*Agree/i), '[class*="scroller"]');
        if (!root || root === document.body || root === document.documentElement) return false;
        let moved = false;
        for (const s of root.querySelectorAll('[class*="scroller"]')) {
            if (s.scrollHeight <= s.clientHeight + 20 || s.clientHeight <= 100) continue;
            const before = s.scrollTop;
            s.scrollTop = Math.min(s.scrollHeight, before + s.clientHeight);
            s.dispatchEvent(new Event("scroll", { bubbles: true }));
            if (s.scrollTop > before) moved = true;
        }
        return moved;
    };

    // Drive the rules list to its end; returns whether anything moved. Stops as
    // soon as a step doesn't scroll (already at the bottom, or nothing to scroll).
    const scrollToEnd = async () => {
        let moved = false;
        for (let i = 0; i < 40 && !outOfTime(); i++) {
            if (!scrollStep()) break;
            moved = true;
            await sleep(120);
        }
        return moved;
    };

    // Poll ~8s for Finish to enable, nudging the rules list each tick: the usual
    // gate is the unread rules ("You must finish reading the rules to join"), but
    // the button can also enable on its own (short list, tall window, late render).
    const waitFinishEnabled = async () => {
        let scrolled = false;
        for (let i = 0; i < 40 && !outOfTime(); i++) {
            const fin = advBtn();
            if (fin && !isDisabled(fin)) return { ok: true, scrolled };
            if (scrollStep()) scrolled = true;
            await sleep(200);
        }
        const fin = advBtn();
        return { ok: !!fin && !isDisabled(fin), scrolled };
    };

    // Wait up to 6s for the click to take (URL leaves /onboarding), unless the
    // time budget runs out first.
    const waitLeftOnboarding = async () => {
        for (let i = 0; i < 30 && !outOfTime(); i++) { await sleep(200); if (!guildOf()) return true; }
        return false;
    };

    // Click Finish on the rules screen and wait for the URL to leave /onboarding.
    const finishRules = async () => {
        let fin = advBtn();
        if (!fin) { log.push("Rules screen: no Finish button found — cannot complete."); return; }
        if (isDisabled(fin)) {
            const st = await waitFinishEnabled();
            log.push("Rules screen: Finish started disabled — waited for it to enable (enabled=" +
                st.ok + ", scrolled=" + st.scrolled + ").");
            fin = advBtn();
            if (!fin || isDisabled(fin)) { log.push("Rules screen: Finish still disabled — cannot complete."); return; }
        }
        fire(fin);
        handled++;
        if (await waitLeftOnboarding()) { log.push("Rules screen: Finish clicked — onboarding complete."); return; }

        // The click didn't take: the button looked enabled but the rules were
        // unread (Finish gates a click without disabling), the portal swallowed
        // it, or aria-disabled hadn't landed. Scroll the rules to the end — which
        // waitFinishEnabled skips while the button already reads enabled — then
        // click once more before giving up.
        if (rulesScreen() && !outOfTime()) {
            const scrolled = await scrollToEnd();
            fin = advBtn();
            if (fin && !isDisabled(fin)) {
                fire(fin);
                log.push("Rules screen: first Finish click did not take — scrolled rules to end and retried (scrolled=" +
                    scrolled + ").");
                if (await waitLeftOnboarding()) { log.push("Rules screen: retry succeeded — onboarding complete."); return; }
            }
        }
        log.push("Rules screen: Finish clicked but onboarding is still on screen — not complete.");
    };

    const qHead = () => captionEl(/^Question\s+\d+\s+of\s+\d+$/i);

    const readState = () => {
        const q = qHead();
        if (!q) return { onboarding: false, guild: guildOf() };
        const m = (q.textContent || "").match(/Question\s+(\d+)\s+of\s+(\d+)/i);
        const row = q.parentElement; // the "Question X of Y · Required" row
        const required = /\bRequired\b/i.test(row ? row.textContent : "");
        return {
            onboarding: true,
            current: +m[1], total: +m[2],
            required, guild: guildOf(), advText: advText(),
        };
    };

    const optionWraps = () => [...document.querySelectorAll('[class*="optionButtonWrapper"]')];

    const fireInside = (box) => {
        const r = box.getBoundingClientRect();
        const cx = Math.round(r.left + r.width / 2), cy = Math.round(r.top + r.height / 2);
        let el = document.elementFromPoint(cx, cy);
        if (!el || !box.contains(el)) el = box;
        fire(el);
    };

    // Dropdown-style question: a visible "Select..." combobox input, scoped to the
    // question — Discord's own search box carries role="combobox" too.
    const comboInput = () => {
        const root = scopeAround(qHead(), 'input[role="combobox"]');
        if (!root) return null;
        for (const el of root.querySelectorAll('input[role="combobox"]')) {
            const r = el.getBoundingClientRect();
            if (r.width > 0 && r.height > 0) return el;
        }
        return null;
    };

    // The listbox renders in a portal, so it is reached through the id the input
    // points at. Discord mounts no node carrying that id — the options do, as
    // their own id prefix. Only an input naming no listbox falls back to a
    // document-wide scan; naming one that is absent means it is not open yet.
    const listOptions = (inp) => {
        const id = inp && (inp.getAttribute("aria-controls") || inp.getAttribute("aria-owns"));
        if (!id) return [...document.querySelectorAll('[role="option"]')];
        const box = document.getElementById(id);
        if (box) return [...box.querySelectorAll('[role="option"]')];
        return [...document.querySelectorAll('[role="option"]')].filter((o) => (o.id || "").indexOf(id) === 0);
    };

    // Discord's combobox keeps the listbox open after a pick — it is multi-select.
    const selectFirstDropdownOption = async () => {
        const inp = comboInput();
        if (!inp) return { ok: false, reason: "no options found" };
        if (inp.getAttribute("aria-expanded") !== "true") {
            try { inp.focus(); } catch (e) { /* ignore */ }
            fire(inp);
        }
        let items = [];
        for (let i = 0; i < 20 && !outOfTime(); i++) { items = listOptions(inp); if (items.length) break; await sleep(150); }
        if (!items.length) return { ok: false, reason: "dropdown did not expand" };
        if (items[0].getAttribute("aria-selected") === "true") return { ok: true, already: true };
        fireInside(items[0]);
        for (let i = 0; i < 20 && !outOfTime(); i++) {
            await sleep(150);
            if (firstSelected() || (advText() || "") !== "Skip") break;
        }
        return { ok: true };
    };

    // Click the first answer option. The clickable handler sits on the inner
    // optionButton (cursor:pointer), not the wrapper (cursor:auto).
    const selectFirstOption = async () => {
        const ws = optionWraps();
        if (!ws.length) return await selectFirstDropdownOption();
        const w = ws[0];
        if (/selected/i.test(w.className)) return { ok: true, already: true };
        fireInside(w.querySelector('[class*="optionButton__"]') || w);
        return { ok: true };
    };

    // Whether this question now has an answer, for either widget. A dropdown whose
    // listbox has collapsed leaves its pick as a removable tag in the field; text
    // alone is not proof, since the unanswered field can render its placeholder.
    const firstSelected = () => {
        const w0 = optionWraps()[0];
        if (w0) return /selected/i.test(w0.className);
        const inp = comboInput();
        if (!inp) return false;
        // Only trust the listbox while the input still names it; a collapsed
        // dropdown drops aria-controls, and listOptions() would then scan the
        // whole document — fall through to the tag/placeholder check instead.
        const listboxId = inp.getAttribute("aria-controls") || inp.getAttribute("aria-owns");
        const o0 = listboxId ? listOptions(inp)[0] : null;
        if (o0) return o0.getAttribute("aria-selected") === "true";
        const field = inp.closest('[class*="selectFieldContainer"]');
        if (!field) return false;
        if (field.querySelector('[class*="tag"]')) return true;
        const txt = (field.textContent || "").trim();
        return !!txt && txt !== (inp.getAttribute("placeholder") || "").trim();
    };

    // Wait until the question advances, the questionnaire closes, or the guild
    // (a different server's onboarding) changes — whichever comes first.
    const waitNext = async (prevCur, prevGuild) => {
        for (let i = 0; i < 35 && !outOfTime(); i++) {
            await sleep(200);
            const s = readState();
            if (!s.onboarding || s.current !== prevCur || s.guild !== prevGuild) return s;
        }
        return readState();
    };

    const startGuild = guildOf();
    // Poll up to 10s for the questionnaire DOM to appear.  The caller navigates
    // to /onboarding first, but Discord may not have rendered the React tree yet.
    // discord_onboarding runs with a 120s budget (the host forwards it
    // through the host), so 10s is well within
    // budget with plenty of headroom for the rest of the questionnaire walk.
    let init = readState();
    if (!init.onboarding && !rulesScreen()) {
        for (let i = 0; i < 10 && !outOfTime(); i++) {
            await sleep(1000);
            init = readState();
            if (init.onboarding || rulesScreen()) break;
        }
    }
    if (!init.onboarding && !rulesScreen()) {
        return { completed: false, handled: 0, startGuild, finalUrl: location.pathname,
            log: ["No onboarding question is on screen — nothing to do (polled 10s)."] };
    }

    let handled = 0, prevCur = -1, prevGuild = startGuild;

    for (let guard = 0; guard < MAX_Q; guard++) {
        if (outOfTime()) { log.push("Out of time budget — stopping with the log so far."); break; }
        const st = readState();
        if (!st.onboarding) { log.push("Onboarding closed — no more questions."); break; }
        if (!ALL_SERVERS && st.guild !== startGuild) {
            log.push("Reached another server's onboarding (" + st.guild + ") — stopping. Pass allServers:true to continue.");
            break;
        }
        if (st.current === prevCur && st.guild === prevGuild) {
            log.push("Stuck on Q" + st.current + " (it did not advance) — aborting.");
            break;
        }
        prevCur = st.current; prevGuild = st.guild;

        if (st.required || ANSWER_OPTIONAL) {
            const sel = await selectFirstOption();
            // Give the advance button a moment to morph away from "Skip".
            for (let i = 0; i < 16 && !outOfTime(); i++) { await sleep(150); if ((advText() || "") !== "Skip") break; }
            const selected = firstSelected();
            const tag = st.required ? "[required]" : "[optional]";
            log.push("Q" + st.current + "/" + st.total + " " + tag +
                " -> selected first option (selected=" + selected + ", button=\"" + advText() + "\"" +
                (sel.ok ? "" : ", WARN: " + sel.reason) + ")");
        } else {
            log.push("Q" + st.current + "/" + st.total + " [optional] -> skip");
        }

        const adv = advBtn();
        if (!adv) { log.push("  No advance button found — aborting."); break; }
        fire(adv);
        handled++;

        const after = await waitNext(st.current, st.guild);
        if (!after.onboarding) { log.push("  Onboarding complete."); break; }
        if (!ALL_SERVERS && after.guild !== startGuild) {
            log.push("  Next server's onboarding appeared (" + after.guild + ") — stopping.");
            break;
        }
    }

    // After the Q&A loop Discord may land on the rules screen before closing onboarding.
    if (rulesScreen() && !outOfTime()) {
        log.push("Rules screen after Q&A — clicking Finish.");
        await finishRules();
    }

    // Base completed on the URL, not readState — readState() returns onboarding:false
    // for both "done" and "stuck on rules screen", so !now.onboarding would falsely
    // report completed:true if finishRules() ran but couldn't find the Finish button.
    const finalGuild = guildOf();
    return {
        completed: !finalGuild || (!ALL_SERVERS && finalGuild !== startGuild),
        handled,
        startGuild,
        finalUrl: location.pathname,
        log,
    };
}

/** The onboarding walk stops itself before the host's 120 s limit: its log only exists here. */
const toolOnboarding = args => walkOnboarding({
    answerOptional: args.answerOptional ?? false,
    allServers: args.allServers ?? false,
    maxQuestions: args.maxQuestions ?? 40,
    budgetMs: 105_000,
});

/* ---------------------------------------------------- wait for messages -- */

/** Slim projection of a MESSAGE_CREATE payload — same shape vocab as `getView`. */
function projectIncomingMessage(msg) {
    const renderName = (u) => u?.globalName ?? u?.global_name ?? u?.username ?? null;
    const ts = msg.timestamp;
    const out = {
        id: msg.id,
        channelId: msg.channel_id ?? msg.channelId,
        guildId: msg.guild_id ?? msg.guildId ?? null,
        content: msg.content || "",
        timestamp: typeof ts === "string" ? ts
            : (typeof ts?.toISOString === "function" ? ts.toISOString() : null),
        author: msg.author ? {
            id: msg.author.id,
            username: msg.author.username,
            name: renderName(msg.author),
            bot: !!msg.author.bot,
        } : null,
    };
    if (msg.attachments?.length) {
        out.attachments = msg.attachments.map((a) => ({
            name: a.filename || a.name,
            url: a.url,
            contentType: a.content_type || a.contentType,
            size: a.size,
        }));
    }
    const refId = msg.message_reference?.message_id
        ?? msg.messageReference?.message_id
        ?? msg.referenced_message?.id;
    if (refId) out.replyTo = { id: refId };
    if (msg.mentions?.length) {
        out.mentions = msg.mentions.map((m) =>
            typeof m === "string" ? { id: m } : { id: m.id, name: renderName(m) });
    }
    if (msg.mention_everyone || msg.mentionEveryone) out.mentionEveryone = true;
    return out;
}


/** Waits for a new message that matches, event-driven. `_since` (ms, set by the host when Discord
 * wasn't running for a while): messages from then on, which no event will bring, count too. */
async function toolWaitForMessage(spec = {}) {
    const FluxDispatcher = need("FluxDispatcher");
    if (!FluxDispatcher?.subscribe || !FluxDispatcher?.unsubscribe)
        throw new Error("FluxDispatcher (dispatch/subscribe) not found.");
    const viewerId = need("UserStore")?.getCurrentUser?.()?.id;

    const timeoutMs = Math.max(1_000, Math.min(600_000, spec.timeoutMs ?? 60_000));
    const cap = Math.max(1, Math.min(50, spec.maxMatches ?? 1));
    const containsLc = spec.contains ? spec.contains.toLowerCase() : null;
    const matches = [];
    const seen = new Set();

    const take = msg => {
        const channelId = msg.channel_id ?? msg.channelId;
        const authorId = msg.author?.id;
        if (seen.has(msg.id)) return;
        if (spec.channelId && channelId !== spec.channelId) return;
        if (spec.fromUserId && authorId !== spec.fromUserId) return;
        if (!spec.includeSelf && viewerId && authorId === viewerId) return;
        if (containsLc && !((msg.content || "").toLowerCase().includes(containsLc))) return;
        if (spec.mentionsViewer && viewerId) {
            const mentioned = Array.isArray(msg.mentions) && msg.mentions.some(m =>
                (typeof m === "string" ? m : m?.id) === viewerId);
            if (!mentioned) return;
        }
        seen.add(msg.id);
        matches.push(projectIncomingMessage(msg));
    };

    return await new Promise(resolve => {
        let done = false, timer;
        const finish = timedOut => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            try { FluxDispatcher.unsubscribe("MESSAGE_CREATE", handler); } catch { /* */ }
            resolve({ done: matches.length > 0, timedOut, matches });
        };
        // Skip optimistic dispatches: those fire before the server confirms the send.
        const handler = payload => {
            try {
                if (payload?.optimistic || !payload?.message) return;
                take(payload.message);
                if (matches.length >= cap) finish(false);
            } catch { /* never let a malformed dispatch end the wait */ }
        };
        FluxDispatcher.subscribe("MESSAGE_CREATE", handler);
        timer = setTimeout(() => finish(true), timeoutMs);
        if (spec._since) catchUp(spec, take).then(() => { if (matches.length >= cap) finish(false); }).catch(() => {});
    });
}

/** History since `spec._since`: the channel asked for, else the channels with unread messages. */
async function catchUp(spec, take) {
    const after = isoToSnowflake(new Date(spec._since).toISOString());
    const reads = need("ReadStateStore");
    const channels = spec.channelId ? [spec.channelId]
        : (need("PrivateChannelSortStore")?.getPrivateChannelIds?.() ?? []).filter(id => reads?.hasUnread?.(id)).slice(0, 10);
    const token = getAuthToken();
    for (const id of channels) {
        const msgs = await restFetchMessages(id, { after, limit: 50 }, token);
        for (const m of [...msgs].reverse()) take(m);
    }
}

/* --------------------------------------------------------------------- guild settings -- */

async function toolMuteGuild(args) {
    const guildId = String(args?.guildId ?? "").trim();
    if (!/^\d{15,25}$/.test(guildId)) throw new Error("`guildId` must be a Discord snowflake.");

    const GuildStore = need("GuildStore");
    const SettingsStore = need("MuteStore");
    const Actions = need("MuteActions");
    if (!SettingsStore?.isMuted)
        throw new Error("Mute-state store not found - webpack module shape may have changed.");
    const guild = GuildStore?.getGuild?.(guildId);
    const durationSeconds = { "15m": 15 * 60, "1h": 60 * 60, "3h": 3 * 60 * 60, "8h": 8 * 60 * 60, "24h": 24 * 60 * 60, "forever": -1 };
    const action = args?.action === "unmute" ? "unmute" : "mute";
    const duration = args?.duration || "forever";
    const selectedWindow = durationSeconds[duration] ?? -1;
    const before = {
        muted: SettingsStore?.isMuted?.(guildId) ?? null,
        muteConfig: SettingsStore?.getMuteConfig?.(guildId) ?? null,
    };
    const preview = {
        guild: guild ? { id: guild.id, name: guild.name, ownerId: guild.ownerId ?? guild.owner_id ?? null } : { id: guildId, name: null },
        action,
        duration: action === "mute" ? duration : null,
        before,
    };

    if (!guild) return { applied: false, alreadyAbsent: true, ...preview };
    if (!Actions?.updateGuildNotificationSettings)
        throw new Error("Guild notification settings action not found - webpack module shape may have changed.");
    if (!args?.apply)
        return {
            applied: false,
            dryRun: true,
            note: "Dry run - membership confirmed but notification settings were not changed. Pass apply: true to update this guild.",
            ...preview,
        };

    const patch = action === "unmute"
        ? { muted: false }
        : {
            muted: true,
            mute_config: {
                selected_time_window: selectedWindow,
                end_time: selectedWindow > 0 ? new Date(Date.now() + selectedWindow * 1000).toISOString() : null,
            },
        };
    await Actions.updateGuildNotificationSettings(guildId, patch);

    for (let i = 0; i < 30; i++) {
        const mutedNow = SettingsStore?.isMuted?.(guildId);
        if (action === "mute" ? mutedNow === true : mutedNow === false) break;
        await sleep(200);
    }
    const after = {
        muted: SettingsStore?.isMuted?.(guildId) ?? null,
        muteConfig: SettingsStore?.getMuteConfig?.(guildId) ?? null,
    };
    return {
        applied: true,
        changed: action === "mute" ? after.muted === true : after.muted === false,
        ...preview,
        patch,
        after,
        note: action === "mute" && selectedWindow <= 0 ? "Muted until manually turned back on."
            : action === "mute" ? "Muted for the requested duration." : "Server unmuted.",
    };
}

async function toolLeave(args) {
    const guildId = String(args?.guildId ?? "").trim();
    if (!/^\d{15,25}$/.test(guildId)) throw new Error("`guildId` must be a Discord snowflake.");

    const GuildStore = need("GuildStore");
    const guild = GuildStore?.getGuild?.(guildId);
    const ownerId = guild?.ownerId ?? guild?.owner_id ?? null;
    const preview = { guild: guild ? { id: guild.id, name: guild.name, ownerId } : { id: guildId, name: null } };

    if (!guild) return { left: false, alreadyAbsent: true, ...preview };
    const me = need("UserStore")?.getCurrentUser?.();
    if (me && ownerId && ownerId === me.id)
        return { left: false, ownsGuild: true, note: "You own this guild — transfer ownership before leaving. Discord rejects owner leaves.", ...preview };
    if (!args?.apply)
        return { left: false, dryRun: true, note: "Dry run — membership confirmed but not changed. Pass apply: true to leave this guild.", ...preview };

    const GuildActions = need("GuildActions");
    if (!GuildActions?.leaveGuild) throw new Error("GuildActions.leaveGuild not found — webpack module shape may have changed.");
    GuildActions.leaveGuild(guildId);
    for (let i = 0; i < 30; i++) {
        if (!GuildStore?.getGuild?.(guildId)) break;
        await sleep(200);
    }
    const stillMember = !!GuildStore?.getGuild?.(guildId);
    return {
        left: !stillMember,
        stillMember,
        ...preview,
        note: stillMember ? "Discord accepted the leave request, but the guild is still in the local store. Re-check shortly."
            : "Left guild and confirmed it is absent from the local guild store.",
    };
}

/* ------------------------------------------------------------------------- the tools -- */

// Every tool, with what it needs from NEEDS. `live`: answers from what the page holds, so after a
// thaw it waits for the reconnect; the rest ask Discord's servers themselves. The host calls them
// by name; a signed-in page has no other way in (no eval, no low-level click or key).
const TOOLS = {
    discord_view: { run: bridgeGetView, live: true, needs: ["AuthTokenStore", "ChannelStore", "GuildStore", "MessageStore", "PresenceStore", "SelectedChannelStore", "TypingStore", "UserStore", "source:chat-messages", "source:messagesWrapper"] },
    discord_send: { run: bridgeSendMessage, needs: ["ChannelActions", "ChannelStore", "CloudUpload", "GuildStore", "MessageActions", "MessageStore", "SelectedChannelStore", "TypingActions"] },
    discord_dms: { run: bridgeListDMs, live: true, needs: ["ChannelStore", "PrivateChannelSortStore", "RelationshipStore", "UserStore"] },
    discord_history: { run: bridgeGetHistory, needs: ["AuthTokenStore", "ChannelStore", "MessageStore", "SelectedChannelStore"] },
    discord_search: { run: bridgeSearchMessages, needs: ["AuthTokenStore", "ChannelStore", "SelectedChannelStore"] },
    discord_user_messages: { run: bridgeUserMessages, needs: ["AuthTokenStore", "GuildStore"] },
    discord_stats: { run: bridgeGetStats, needs: ["AuthTokenStore", "ChannelStore", "MessageStore", "SelectedChannelStore"] },
    discord_open: { run: bridgeOpenChannel, live: true, needs: ["ChannelRouter", "ChannelStore", "GuildStore", "MessageStore", "NavigationRouter", "SelectedChannelStore", "UserStore"] },
    discord_react: { run: bridgeReact, needs: ["ChannelStore", "MessageStore", "ReactionActions", "SelectedChannelStore", "UserStore"] },
    discord_edit: { run: bridgeEdit, needs: ["MessageActions", "MessageStore", "SelectedChannelStore", "UserStore"] },
    discord_delete: { run: bridgeDelete, needs: ["MessageActions", "MessageStore", "SelectedChannelStore", "UserStore"] },
    discord_pins: { run: bridgePins, needs: ["AuthTokenStore", "ChannelStore", "SelectedChannelStore"] },
    discord_threads: { run: bridgeThreads, needs: ["AuthTokenStore", "ChannelStore", "SelectedChannelStore"] },
    discord_member: { run: bridgeMember, needs: ["AuthTokenStore", "PresenceStore", "UserStore"] },
    discord_unread: { run: bridgeUnread, live: true, needs: ["AuthTokenStore", "ChannelStore", "GuildChannelStore", "GuildStore", "PrivateChannelSortStore", "ReadStateStore", "RelationshipStore", "UserStore"] },
    discord_ack: { run: bridgeAck, needs: ["AuthTokenStore", "ChannelStore", "MessageStore", "ReadStateStore"] },
    discord_emoji: { run: bridgeEmoji, live: true, needs: ["EmojiStore", "GuildStore"] },
    discord_dm_open: { run: bridgeDmOpen, needs: ["AuthTokenStore", "ChannelRouter", "ChannelStore", "MessageStore", "NavigationRouter", "RelationshipStore", "UserStore"] },
    discord_attachment: { run: bridgeAttachment, needs: ["AuthTokenStore", "MessageStore", "SelectedChannelStore"] },
    discord_resolveMessage: { run: bridgeResolveMessage, needs: ["AuthTokenStore", "ChannelStore", "MessageStore", "SelectedChannelStore"] },
    discord_guilds: { run: bridgeListGuilds, live: true, needs: ["GuildStore", "SortedGuildStore"] },
    discord_organize: { run: bridgeOrganizeGuilds, needs: ["GuildStore", "PreloadedUserSettings"] },
    discord_join: { run: bridgeJoinInvite, needs: ["GuildStore", "InviteActions"] },
    discord_leave: { run: toolLeave, needs: ["GuildActions", "GuildStore", "UserStore"] },
    discord_mute_guild: { run: toolMuteGuild, needs: ["GuildStore", "MuteActions", "MuteStore"] },
    discord_waitForMessage: { run: toolWaitForMessage, live: true, needs: ["AuthTokenStore", "FluxDispatcher", "PrivateChannelSortStore", "ReadStateStore", "UserStore"] },
    discord_onboarding: { run: toolOnboarding, live: true, needs: ["source:optionButtonWrapper"] },
};

/** Where an element is on the page, for a screenshot of just that. */
async function elementRect(selector) {
    const el = document.querySelector(selector);
    if (!el) throw new Error("selector matched nothing: " + selector);
    try { el.scrollIntoView({ block: "center" }); } catch { /* */ }
    await sleep(150);
    const r = el.getBoundingClientRect();
    const x = Math.max(0, Math.floor(r.left)), y = Math.max(0, Math.floor(r.top));
    const rect = { x, y, width: Math.min(Math.ceil(r.width), innerWidth - x), height: Math.min(Math.ceil(r.height), innerHeight - y) };
    if (rect.width < 1 || rect.height < 1) throw new Error("element is off-screen or has zero size: " + selector);
    return rect;
}

/** Whether a string is in any of Discord's modules: their source is plain text in the bundle. */
function inBundle(texts) {
    const left = new Set(texts);
    const mods = Web()?.wreq?.m ?? {};
    for (const id of Object.keys(mods)) {
        const src = String(mods[id]);
        for (const t of left) if (src.includes(t)) left.delete(t);
        if (!left.size) break;
    }
    return t => !left.has(t);
}

/** Checks every internal the tools need. Read-only: it finds things and calls nothing. */
function selftest() {
    found.clear();
    const needs = {};
    const sources = Object.values(NEEDS).filter(s => s.source).map(s => s.source);
    const has = inBundle(sources);
    const chat = !!document.querySelector('[data-list-id="chat-messages"]');
    for (const [name, spec] of Object.entries(NEEDS)) {
        const ok = spec.source ? has(spec.source) : !!need(name);
        needs[name] = ok ? "ok" : spec.optional ? "optional" : spec.lazy && !chat ? "later" : "missing";
    }
    const tools = {};
    for (const [name, t] of Object.entries(TOOLS)) {
        const missing = t.needs.filter(n => needs[n] === "missing");
        if (missing.length) tools[name] = missing;
    }
    return { vencord: !!Web()?.wreq, build: discordBuild(), needs, tools };
}

function discordBuild() {
    const env = window.GLOBAL_ENV ?? {};
    return String(env.SENTRY_TAGS?.buildId ?? env.BUILD_NUMBER ?? env.VERSION_HASH ?? "");
}

function me() {
    const u = need("UserStore")?.getCurrentUser?.();
    return u ? { id: u.id, username: u.username, name: u.globalName ?? u.global_name ?? u.username } : null;
}

/** A hCaptcha someone can see (Discord keeps invisible ones around too). */
function captchaShowing() {
    return [...document.querySelectorAll('iframe[src*="hcaptcha.com"]')].some(f => {
        const r = f.getBoundingClientRect();
        return r.width >= 80 && r.height >= 40 && getComputedStyle(f).visibility !== "hidden";
    });
}

/* ---------------------------------------------------------- the gateway after a freeze -- */

/** How long live tools wait for the reconnect after a thaw. */
const LIVE_WAIT_MS = 20_000;

// One page has one record, however often this script is injected again.
const gate = (window.$harborGate ??= { caught: true, thawedAt: 0, opens: 0, resumes: 0, closes: 0, watching: false, wake: [] });

function caughtUp() {
    gate.caught = true;
    for (const w of gate.wake.splice(0)) w();
}

/** Discord's own events for its connection. CONNECTION_OPEN is a full login (READY), RESUMED a
 * resume whose missed events have all been replayed by the time it comes. */
function watchGateway() {
    const flux = need("FluxDispatcher");
    if (gate.watching || !flux?.subscribe) return;
    gate.watching = true;
    flux.subscribe("CONNECTION_OPEN", () => { gate.opens++; caughtUp(); });
    flux.subscribe("CONNECTION_RESUMED", () => { gate.resumes++; caughtUp(); });
    const lost = () => { gate.closes++; gate.caught = false; };
    flux.subscribe("CONNECTION_INTERRUPTED", lost);
    flux.subscribe("CONNECTION_CLOSED", lost);
}

/** The connection answered a heartbeat since the thaw: it never dropped, and whatever the server
 * held for it has arrived ahead of that answer. */
function heartbeatAnswered() {
    const s = need("GatewayConnectionStore")?.getSocket?.();
    return !!s?.isSessionEstablished?.() && (s.lastHeartbeatAckTime ?? 0) >= gate.thawedAt;
}

/** Waits for the store data to be current again; right away if nothing's outstanding. */
async function settled() {
    const until = Date.now() + LIVE_WAIT_MS;
    while (!gate.caught) {
        if (heartbeatAnswered()) caughtUp();
        else {
            const left = until - Date.now();
            if (left <= 0) throw new Error("Discord hasn't reconnected yet, so this would show old data. Try again in a moment.");
            await Promise.race([new Promise(r => gate.wake.push(r)), sleep(Math.min(left, 250))]);
        }
    }
}

window.$harbor = {
    /** Runs a tool; the result as JSON text, so it crosses any engine's boundary the same way. */
    async call(name, args) {
        const t = Object.hasOwn(TOOLS, name) ? TOOLS[name] : null;
        if (!t) throw new Error("No such tool: " + name);
        if (t.live) await settled();
        return JSON.stringify(await t.run(args ?? {}) ?? null);
    },
    ready: () => {
        const up = !!Web()?.wreq && !!need("UserStore");
        if (up) watchGateway();
        return up;
    },
    /** The client was frozen: from here, store data is old until the connection is checked. Same
     * as what Discord's desktop app does when the PC wakes. */
    thawed() {
        gate.thawedAt = Date.now();
        gate.caught = false;
        try { need("GatewayConnectionStore")?.getSocket?.()?.expeditedHeartbeat?.(5000, "thawed"); } catch { /* the wait reports it */ }
        return { path: location.pathname, user: me() };
    },
    settled,
    gateway: () => ({ opens: gate.opens, resumes: gate.resumes, closes: gate.closes, caught: gate.caught }),
    selftest,
    elementRect,
    /** What sign-in and the host watch: who's signed in, and what the login page shows. */
    state: () => ({
        user: me(),
        path: location.pathname,
        captcha: captchaShowing(),
        // After the phone scans, the login page shows the scanned account's picture.
        scanned: location.pathname.startsWith("/login") && !!document.querySelector('img[src*="avatars"]'),
    }),
    /** Ends this session at Discord (Sign out in Harbor). */
    async logout() {
        const token = getAuthToken();
        await api("https://discord.com/api/v9/auth/logout", {
            method: "POST",
            headers: { authorization: token, "content-type": "application/json" },
            body: '{"provider":null,"voip_provider":null}',
        });
    },
};
})();
