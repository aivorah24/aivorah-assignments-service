/**
 * /assignments/library - the signed-in teacher's private assignment library
 * (services/teacherLibrary.js). Who the teacher is comes from their sign-in
 * token (middleware/requireTeacher.js), never from the request, so no teacher
 * can list or open another teacher's library.
 *
 *   GET    /assignments/library       -> { items: [summary...] } newest-used first
 *   GET    /assignments/library/:id   -> { item: { ...summary, content } }
 *   DELETE /assignments/library/:id   -> { ok: true }
 *
 * To assign an item again, the app POSTs its content to /assignments with a
 * new dueDate and recipient (plus libraryItemId).
 */
const express = require('express');
const { requireTeacher } = require('../middleware/requireTeacher');
const library = require('../services/teacherLibrary');

const router = express.Router();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

router.use(requireTeacher);

router.get('/', async (req, res) => {
  try {
    res.json({ items: await library.listLibrary(req.user.id) });
  } catch (err) {
    console.error('[GET /assignments/library]', err.message);
    res.status(500).json({ error: 'Could not load your library' });
  }
});

router.get('/:id', async (req, res) => {
  if (!UUID.test(req.params.id)) return res.status(404).json({ error: 'Not found' });
  try {
    const item = await library.getLibraryItem(req.user.id, req.params.id);
    if (!item) return res.status(404).json({ error: 'Not found' });
    res.json({ item });
  } catch (err) {
    console.error('[GET /assignments/library/:id]', err.message);
    res.status(500).json({ error: 'Could not open this library item' });
  }
});

router.delete('/:id', async (req, res) => {
  if (!UUID.test(req.params.id)) return res.status(404).json({ error: 'Not found' });
  try {
    const removed = await library.deleteLibraryItem(req.user.id, req.params.id);
    if (!removed) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true });
  } catch (err) {
    console.error('[DELETE /assignments/library/:id]', err.message);
    res.status(500).json({ error: 'Could not remove this library item' });
  }
});

module.exports = router;
