// One function for every /api route (see config.path below).
// MongoDB keeps each postcard as ONE document (text, colours, fonts, stamp settings, drawing strokes).
// Netlify Blobs keeps only the binary images (cropped-photo source, imported stamp image, thumbnail).
import { MongoClient, ObjectId } from 'mongodb';
import { getStore } from '@netlify/blobs';

let client;
const postcards = async () => {
  client ??= await new MongoClient(process.env.MONGODB_URI).connect();
  return client.db(process.env.MONGODB_DB || 'pollypost').collection('postcards');
};
const keysOf = (p) => [p?.thumb, p?.design?.photo?.key, p?.design?.stamp?.c?.key].filter(Boolean);
const json = (data, status = 200) => Response.json(data, { status });

export default async (req) => {
  const [, kind, id] = new URL(req.url).pathname.split('/').filter(Boolean); // /api/<kind>/<id>
  const owner = req.headers.get('x-owner');
  try {
    if (kind === 'blobs') {
      const store = getStore('postcard-images');
      if (req.method === 'POST') {
        const key = crypto.randomUUID();
        await store.set(key, await req.arrayBuffer(), { metadata: { type: req.headers.get('content-type') || 'image/jpeg' } });
        return json({ key }, 201);
      }
      if (req.method === 'GET') {
        const r = await store.getWithMetadata(id, { type: 'arrayBuffer' });
        if (!r) return json({ error: 'Not found' }, 404);
        return new Response(r.data, { headers: { 'content-type': r.metadata?.type || 'image/jpeg', 'cache-control': 'public, max-age=31536000, immutable' } });
      }
    }
    if (kind === 'postcards') {
      if (!owner) return json({ error: 'Missing x-owner header' }, 400);
      const col = await postcards();
      const _id = id && ObjectId.isValid(id) ? new ObjectId(id) : null;
      if (req.method === 'GET' && !id) return json(await col.find({ owner }, { projection: { design: 0 } }).sort({ updatedAt: -1 }).toArray());
      if (id && !_id) return json({ error: 'Bad id' }, 400);
      const blobs = getStore('postcard-images');
      if (req.method === 'GET') {
        const doc = await col.findOne({ _id, owner });
        return doc ? json(doc) : json({ error: 'Not found' }, 404);
      }
      if (req.method === 'POST') {
        const { title, thumb, design } = await req.json();
        const now = new Date();
        const r = await col.insertOne({ owner, title, thumb, design, createdAt: now, updatedAt: now });
        return json({ _id: r.insertedId }, 201);
      }
      if (req.method === 'PUT') {
        const old = await col.findOne({ _id, owner });
        if (!old) return json({ error: 'Not found' }, 404);
        const { title, thumb, design } = await req.json();
        await col.updateOne({ _id, owner }, { $set: { title, thumb, design, updatedAt: new Date() } });
        const keep = new Set(keysOf({ thumb, design }));
        await Promise.all(keysOf(old).filter((k) => !keep.has(k)).map((k) => blobs.delete(k))); // remove images no longer used
        return json({ _id });
      }
      if (req.method === 'DELETE') {
        const old = await col.findOneAndDelete({ _id, owner });
        if (old) await Promise.all(keysOf(old).map((k) => blobs.delete(k)));
        return json({ ok: true });
      }
    }
    return json({ error: 'Not found' }, 404);
  } catch (e) {
    console.error(e);
    return json({ error: 'Server error' }, 500);
  }
};

export const config = { path: ['/api/postcards', '/api/postcards/*', '/api/blobs', '/api/blobs/*'] };
