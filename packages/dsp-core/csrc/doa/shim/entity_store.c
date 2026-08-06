#include "entity_store.h"

#include <string.h>

static entity_blob_t g_blob;
static int g_inited;

void entity_store_core_init(void) {
  if (!g_inited) {
    memset(&g_blob, 0, sizeof(g_blob));
    g_blob.next_id = 1;
    g_inited = 1;
  }
}

void entity_store_init(void) { entity_store_core_init(); }
void entity_store_dump_uart(void) {}
void entity_store_poll(bool usb_audio_idle) { (void)usb_audio_idle; }
bool entity_store_dirty(void) { return false; }
bool entity_store_saving(void) { return false; }
uint32_t entity_store_count(void) { return g_blob.count; }
uint32_t entity_store_next_id(void) { return g_blob.next_id; }
const entity_slot_t *entity_store_slot(uint32_t index) {
  return index < ENTITY_STORE_MAX ? &g_blob.slots[index] : NULL;
}
void entity_store_export_uart(void) {}
bool entity_store_import_begin(void) { return true; }
bool entity_store_import_hex_line(const char *line) {
  (void)line;
  return true;
}
bool entity_store_import_end(void) { return true; }
uint32_t entity_blob_crc(const entity_blob_t *b) {
  (void)b;
  return 0;
}

const char *entity_class_name(entity_class_t c) {
  switch (c) {
    case ENT_HUMAN: return "human";
    case ENT_CAT: return "cat";
    case ENT_DOG: return "dog";
    case ENT_ICE: return "ice";
    case ENT_EV: return "ev";
    case ENT_BIRD: return "bird";
    case ENT_SONGBIRD: return "songbird";
    case ENT_CORVID: return "corvid";
    default: return "none";
  }
}

uint32_t entity_store_match_or_create(entity_class_t cls, const entity_sig_t *sig,
                                      float *match_out) {
  entity_store_core_init();
  if (match_out) *match_out = 0.0f;
  if (g_blob.count >= ENTITY_STORE_MAX) return 0;
  uint32_t i = g_blob.count++;
  g_blob.slots[i].used = 1;
  g_blob.slots[i].id = g_blob.next_id++;
  g_blob.slots[i].cls = (uint32_t)cls;
  g_blob.slots[i].hits = 1;
  if (sig) g_blob.slots[i].sig = *sig;
  return g_blob.slots[i].id;
}
