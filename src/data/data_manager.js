const fs = require('fs');
const path = require('path');

// Note: this is called both once at startup AND on every dashboard poll (web_editor.js's
// /api/world_entities etc. call it every few seconds) - don't log per-call here, it floods the
// console. The one legitimate startup log line lives at the call site in
// context_manager.js initializeWorldContext(), the only caller that represents an actual
// "loading/refreshing the world" moment rather than a routine dashboard read.
async function getAllWorldData() {
    const worldData = {
        characters: [],
        npcs: [],
        locations: [],
        items: [],
        quests: [],
        lore: [],
        encounters: [],
        sessions: []
    };

    const tempDataPath = path.join(__dirname, '..', '..', 'temp_data');

    if (!fs.existsSync(tempDataPath)) {
        fs.mkdirSync(tempDataPath, { recursive: true });
        return worldData;
    }
    
    const dataDirectories = [
        { dir: 'characters', key: 'characters' },
        { dir: 'npcs', key: 'npcs' },
        { dir: 'locations', key: 'locations' },
        { dir: 'items', key: 'items' },
        { dir: 'quests', key: 'quests' },
        { dir: 'lore', key: 'lore' },
        { dir: 'encounters', key: 'encounters' },
        { dir: 'sessions', key: 'sessions' }
    ];
    
    // Load data from each directory
    for (const { dir, key } of dataDirectories) {
        const folderPath = path.join(tempDataPath, dir);
        
        if (fs.existsSync(folderPath)) {
            try {
                const files = fs.readdirSync(folderPath);
                const records = [];
                
                for (const file of files) {
                    if (file.endsWith('.json')) {
                        try {
                            const filePath = path.join(folderPath, file);
                            const content = fs.readFileSync(filePath, 'utf8');
                            const record = JSON.parse(content);
                            
                            if (!record.id) {
                                record.id = file.replace('.json', '');
                            }
                            
                            records.push(record);
                        } catch (e) {
                            console.warn(`-> Failed to parse ${file} in ${dir}:`, e.message);
                        }
                    }
                }
                
                if (records.length > 0) {
                    worldData[key] = records;
                }
            } catch (e) {
                console.warn(`-> Failed to read ${dir} directory:`, e.message);
            }
        } else {
            fs.mkdirSync(folderPath, { recursive: true });
        }
    }

    return worldData;
}

function saveEntity(entityType, entity) {
    const tempDataPath = path.join(__dirname, '..', '..', 'temp_data');
    
    const validTypes = ['characters', 'npcs', 'locations', 'items', 'quests', 'lore', 'encounters', 'sessions'];
    if (!validTypes.includes(entityType)) {
        throw new Error(`Invalid entity type: ${entityType}`);
    }
    
    if (!entity.id) {
        entity.id = `entity_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
    }
    
    const dirPath = path.join(tempDataPath, entityType);
    if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true });
    }
    
    const filePath = path.join(dirPath, `${entity.id}.json`);
    fs.writeFileSync(filePath, JSON.stringify(entity, null, 2), 'utf8');
    
    console.log(`-> Saved ${entityType}/${entity.id}`);
    return entity;
}

// Deletes every stored entity file across all types - used when starting a fresh campaign,
// so old NPCs/locations/lore don't linger alongside newly-generated ones.
function clearAllEntities() {
    const tempDataPath = path.join(__dirname, '..', '..', 'temp_data');
    const validTypes = ['characters', 'npcs', 'locations', 'items', 'quests', 'lore', 'encounters', 'sessions'];
    let cleared = 0;

    for (const entityType of validTypes) {
        const dirPath = path.join(tempDataPath, entityType);
        if (!fs.existsSync(dirPath)) continue;

        for (const file of fs.readdirSync(dirPath)) {
            if (file.endsWith('.json')) {
                fs.unlinkSync(path.join(dirPath, file));
                cleared++;
            }
        }
    }

    console.log(`-> Cleared ${cleared} world entity files`);
    return cleared;
}

module.exports = {
    getAllWorldData,
    saveEntity,
    clearAllEntities
};