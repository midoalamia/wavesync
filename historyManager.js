/**
 * History Manager (historyManager.js)
 * Manages undo/redo for timeline adjustments and track modifications
 */

class HistoryManager {
  constructor(maxHistorySize = 50) {
    this.history = []; // Stack of history states
    this.currentIndex = -1; // Current position in history
    this.maxHistorySize = maxHistorySize;
  }

  /**
   * Push a new state to history
   * @param {object} action - Action object with type and payload
   * @param {string} action.type - Type of action (e.g., 'ADJUST_OFFSET', 'MUTE_TRACK')
   * @param {object} action.payload - Data related to the action
   * @param {string} action.description - Human-readable description
   * @returns {boolean} Success status
   */
  push(action) {
    if (!action || !action.type) {
      console.error('Invalid action: must include type and payload');
      return false;
    }

    // Remove any "future" history if we're not at the end
    if (this.currentIndex < this.history.length - 1) {
      this.history = this.history.slice(0, this.currentIndex + 1);
    }

    // Add timestamp
    const historyEntry = {
      ...action,
      timestamp: Date.now(),
    };

    this.history.push(historyEntry);
    this.currentIndex++;

    // Enforce max history size (FIFO removal)
    if (this.history.length > this.maxHistorySize) {
      this.history.shift();
      this.currentIndex--;
    }

    console.log(`[HISTORY] Action pushed: ${action.description || action.type}`);
    return true;
  }

  /**
   * Undo last action
   * @returns {object|null} Previous state or null if at beginning
   */
  undo() {
    if (this.currentIndex <= 0) {
      console.warn('[HISTORY] Cannot undo: at beginning of history');
      return null;
    }

    this.currentIndex--;
    const action = this.history[this.currentIndex];
    console.log(`[HISTORY] Undo: ${action.description || action.type}`);
    return this.createUndoAction(action);
  }

  /**
   * Redo last undone action
   * @returns {object|null} Next state or null if at end
   */
  redo() {
    if (this.currentIndex >= this.history.length - 1) {
      console.warn('[HISTORY] Cannot redo: at end of history');
      return null;
    }

    this.currentIndex++;
    const action = this.history[this.currentIndex];
    console.log(`[HISTORY] Redo: ${action.description || action.type}`);
    return action;
  }

  /**
   * Create inverse action for undo operations
   * @param {object} action - Original action
   * @returns {object} Inverse action
   */
  createUndoAction(action) {
    const inverseAction = {
      ...action,
      isUndo: true,
      originalType: action.type,
    };

    // Create reverse payload based on action type
    switch (action.type) {
      case 'ADJUST_OFFSET':
        inverseAction.payload = {
          ...action.payload,
          offset: -action.payload.offset, // Reverse offset
        };
        break;

      case 'MUTE_TRACK':
        inverseAction.payload = {
          ...action.payload,
          muted: !action.payload.muted, // Toggle mute state
        };
        break;

      case 'CHANGE_GAIN':
        inverseAction.payload = {
          ...action.payload,
          gain: 1 / action.payload.gain, // Inverse gain
        };
        break;

      case 'DELETE_TRACK':
        // For delete, we need to restore the track
        inverseAction.type = 'RESTORE_TRACK';
        break;

      default:
        console.warn(`[HISTORY] No inverse action defined for type: ${action.type}`);
    }

    return inverseAction;
  }

  /**
   * Get current history state
   * @returns {object|null} Current action or null
   */
  getCurrentState() {
    if (this.currentIndex < 0 || this.currentIndex >= this.history.length) {
      return null;
    }
    return this.history[this.currentIndex];
  }

  /**
   * Get full history for UI display
   * @returns {array} History entries
   */
  getHistory() {
    return this.history.map((entry, index) => ({
      ...entry,
      isActive: index === this.currentIndex,
      canUndo: this.currentIndex > 0,
      canRedo: this.currentIndex < this.history.length - 1,
    }));
  }

  /**
   * Check if can undo
   * @returns {boolean}
   */
  canUndo() {
    return this.currentIndex > 0;
  }

  /**
   * Check if can redo
   * @returns {boolean}
   */
  canRedo() {
    return this.currentIndex < this.history.length - 1;
  }

  /**
   * Clear entire history
   */
  clear() {
    this.history = [];
    this.currentIndex = -1;
    console.log('[HISTORY] History cleared');
  }

  /**
   * Get history size (for UI feedback)
   * @returns {object} History metrics
   */
  getSize() {
    return {
      totalEntries: this.history.length,
      currentIndex: this.currentIndex,
      undoCount: this.currentIndex,
      redoCount: this.history.length - this.currentIndex - 1,
    };
  }

  /**
   * Export history as JSON for debugging
   * @returns {string} JSON string
   */
  exportHistory() {
    return JSON.stringify(this.history, null, 2);
  }

  /**
   * Import history from JSON (for recovery)
   * @param {string} jsonData - JSON history data
   * @returns {boolean} Success status
   */
  importHistory(jsonData) {
    try {
      const imported = JSON.parse(jsonData);
      if (!Array.isArray(imported)) {
        throw new Error('Invalid history format');
      }
      this.history = imported;
      this.currentIndex = imported.length - 1;
      console.log('[HISTORY] History imported successfully');
      return true;
    } catch (error) {
      console.error('Failed to import history:', error);
      return false;
    }
  }
}

module.exports = HistoryManager;
