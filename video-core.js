import { ShareError, positiveId, parseMediaReference, selectCampaign, createPublisher,
  diagnosticFields, withTimeout } from './core.js?v=0.3.0';

function expectedMedia(campaign) {
  const { attachment } = parseMediaReference(campaign.mediaReference);
  const [, owner, id] = /^video(-?[1-9]\d*)_([1-9]\d*)$/.exec(attachment);
  return { attachment, ownerId: Number(owner), id: Number(id) };
}

function sourcePost(campaign, response) {
  selectCampaign('', { selected: campaign }, 'selected');
  const [, owner, id] = /^\/wall(-?[1-9]\d*)_([1-9]\d*)$/.exec(new URL(campaign.sourceUrl).pathname);
  const items = response?.response?.items;
  if (!Array.isArray(items) || items.length !== 1 || items[0]?.owner_id !== Number(owner)
      || items[0]?.id !== Number(id)) throw new ShareError('SOURCE_NOT_CONFIRMED');
  return items[0];
}

function matchingVideo(item, expected) {
  return item && item.owner_id === expected.ownerId && item.id === expected.id;
}

export function sourceMedia(campaign, response) {
  const expected = expectedMedia(campaign);
  const post = sourcePost(campaign, response);
  if (!Array.isArray(post.attachments) || post.attachments.length > 100) throw new ShareError('VIDEO_NOT_FOUND');
  const attachments = post.attachments.filter((item) => ['video', 'clip'].includes(item?.type)
    && matchingVideo(item[item.type], expected));
  if (attachments.length !== 1) throw new ShareError('VIDEO_NOT_FOUND');
  const item = attachments[0];
  if (item[item.type].can_repost === 0 || item[item.type].can_repost === false) {
    throw new ShareError('VIDEO_SHARING_UNAVAILABLE');
  }
  return { ...expected, kind: item.type };
}

export function confirmedVideo(media, response) {
  const items = response?.response?.items;
  if (!Array.isArray(items) || items.length !== 1 || !matchingVideo(items[0], media)) {
    throw new ShareError('CLIP_VIDEO_NOT_CONFIRMED');
  }
  if (items[0].can_repost === 0 || items[0].can_repost === false) throw new ShareError('VIDEO_SHARING_UNAVAILABLE');
  return true;
}

function publishedPostId(result, userId) {
  const text = String(result?.post_id ?? '');
  if (/^[1-9]\d*$/.test(text)) return positiveId(text);
  const match = /^([1-9]\d*)_([1-9]\d*)$/.exec(text);
  if (!match || Number(positiveId(match[1])) !== userId) throw new ShareError('PUBLISHED_POST_NOT_CONFIRMED');
  return positiveId(match[2]);
}

export function publicationHasVideo(result, postId, userId, media) {
  const items = result?.response?.items;
  if (!Array.isArray(items) || items.length !== 1 || items[0]?.owner_id !== userId
    || items[0]?.id !== Number(postId) || !Array.isArray(items[0].attachments)) return false;
  return items[0].attachments.some((item) => ['video', 'clip'].includes(item?.type)
    && matchingVideo(item[item.type], media));
}

export function createVideoPublisher({ bridge, appId, userId, campaign, onState = () => {},
  onDiagnostic = () => {}, log = () => {}, requestTimeoutMs = 15000, slowAfterMs = 45000 }) {
  const applicationId = Number(positiveId(appId));
  const ownerId = Number(positiveId(userId));
  const selected = selectCampaign('', { selected: campaign }, 'selected');
  const sourceId = new URL(selected.sourceUrl).pathname.slice('/wall'.length);
  selected.id = sourceId.split('_')[1];
  let preparation;
  let publisher;
  let token;
  let state = 'preparing';
  const update = (next) => {
    state = next;
    if (['published', 'unconfirmed'].includes(next)) token = undefined;
    onState(next);
  };
  const read = (method, params) => withTimeout(bridge.send('VKWebAppCallAPIMethod', {
    method, params: { v: '5.199', access_token: token, ...params },
  }), requestTimeoutMs);

  return {
    get state() { return state; },
    prepare() {
      if (publisher) return Promise.resolve(true);
      if (preparation) return preparation;
      let phase = 'VIDEO_AUTH';
      const started = performance.now();
      preparation = Promise.resolve().then(async () => {
        update('authorizing'); log('info', 'video.preparing', { campaign: campaign.id });
        const auth = await bridge.send('VKWebAppGetAuthToken', { app_id: applicationId, scope: 'wall' });
        if (typeof auth?.access_token !== 'string' || !auth.access_token
          || typeof auth.scope !== 'string' || !auth.scope.split(',').map((value) => value.trim()).includes('wall')) {
          throw new ShareError('WALL_PERMISSION_MISSING');
        }
        token = auth.access_token;
        phase = 'VIDEO_SOURCE'; update('preparing');
        const media = sourceMedia(selected, await read('wall.getById', { posts: sourceId }));
        log('info', 'video.source_checked', { mediaKind: media.kind });
        if (media.kind === 'clip') {
          phase = 'CLIP_VIDEO_CHECK';
          // A clip URL alone does not prove that the video attachment exists.
          confirmedVideo(media, await read('video.get', { videos: `${media.ownerId}_${media.id}` }));
          log('info', 'video.clip_object_checked');
        }
        const preparedCampaign = { ...selected, attachment: media.attachment, kind: media.kind };
        publisher = createPublisher({ bridge, campaign: preparedCampaign, onState: update, onDiagnostic, log,
          slowAfterMs, verifyResult: async (result) => {
            const verifyStarted = performance.now();
            try {
              const postId = publishedPostId(result, ownerId);
              const confirmed = publicationHasVideo(await read('wall.getById', {
                posts: `${ownerId}_${postId}`,
              }), postId, ownerId, media);
              if (!confirmed) throw new ShareError('PUBLISHED_VIDEO_NOT_CONFIRMED');
              log('info', 'video.publication_verified', { elapsedMs: Math.round(performance.now() - verifyStarted) });
              return true;
            } catch (error) {
              const diagnostic = { phase: 'VIDEO_PUBLICATION_VERIFY', ...diagnosticFields(error) };
              onDiagnostic(diagnostic); log('warning', 'video.verification_failed', {
                ...diagnostic, elapsedMs: Math.round(performance.now() - verifyStarted),
              });
              return false;
            }
          },
        });
        update('ready'); log('info', 'video.ready', { elapsedMs: Math.round(performance.now() - started) });
        return true;
      }).catch((error) => {
        token = undefined;
        const diagnostic = { phase, ...diagnosticFields(error) };
        onDiagnostic(diagnostic); update('error');
        log('warning', 'video.preparation_failed', { ...diagnostic,
          elapsedMs: Math.round(performance.now() - started) });
        return false;
      }).finally(() => { preparation = undefined; });
      return preparation;
    },
    open() { return publisher ? publisher.open() : Promise.resolve('not_ready'); },
  };
}
