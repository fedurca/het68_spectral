#include "detection_log.h"

#include <string.h>

static det_blob_t g_log;
static int g_inited;
static int g_synced = 1; /* host always treats time as synced */

void detection_log_core_init(void) {
  if (!g_inited) {
    memset(&g_log, 0, sizeof(g_log));
    g_log.next_id = 1;
    g_inited = 1;
  }
}

void detection_log_init(void) { detection_log_core_init(); }
void detection_log_poll(bool usb_audio_idle) { (void)usb_audio_idle; }
bool detection_log_dirty(void) { return false; }
bool detection_log_saving(void) { return false; }
uint32_t detection_log_count(void) { return g_log.count; }
const det_slot_t *detection_log_slot(uint32_t index) {
  return index < DET_LOG_MAX ? &g_log.slots[index] : NULL;
}
bool detection_log_delete_id(uint32_t id) {
  (void)id;
  return false;
}
void detection_log_clear(void) {
  memset(&g_log, 0, sizeof(g_log));
  g_log.next_id = 1;
}
void detection_log_list_uart(void) {}
void detection_log_export_nvr(void) {}
void detection_log_export_hex(void) {}
bool detection_log_import_begin(void) { return true; }
bool detection_log_import_hex_line(const char *line) {
  (void)line;
  return true;
}
bool detection_log_import_end(void) { return true; }

const char *det_class_name(det_class_t c) {
  switch (c) {
    case DET_WIND: return "wind";
    case DET_DRONE: return "drone";
    case DET_VEHICLE: return "vehicle";
    case DET_ICE: return "ice";
    case DET_EV: return "ev";
    case DET_WALKER: return "walker";
    case DET_HUMAN: return "human";
    case DET_CAT: return "cat";
    case DET_DOG: return "dog";
    case DET_BIRD: return "bird";
    case DET_SONGBIRD: return "songbird";
    case DET_CORVID: return "corvid";
    default: return "none";
  }
}

det_class_t det_class_from_name(const char *name) {
  (void)name;
  return DET_NONE;
}

uint32_t detection_log_observe(det_class_t cls, uint32_t entity_id, float az,
                               float el, float intensity_db, float conf) {
  detection_log_core_init();
  if (!g_synced) return 0;
  if (g_log.count >= DET_LOG_MAX) return 0;
  uint32_t i = g_log.count++;
  g_log.slots[i].used = 1;
  g_log.slots[i].id = g_log.next_id++;
  g_log.slots[i].cls = (uint32_t)cls;
  g_log.slots[i].entity_id = entity_id;
  g_log.slots[i].az = az;
  g_log.slots[i].el = el;
  g_log.slots[i].intensity_db = intensity_db;
  g_log.slots[i].conf = conf;
  g_log.slots[i].occurrence = 1;
  return g_log.slots[i].id;
}
