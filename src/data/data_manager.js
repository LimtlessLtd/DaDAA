const fs = require('fs');
const path = require('path');

async function getAllWorldData() {
    console.log("--- DaDAA: Loading Game Data ---");
    
    const worldData = {
        characters: [],
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
        console.log("-> Created temp_data directory");
        return worldData;
    }
    
    const dataDirectories = [
        { dir: 'characters', key: 'characters' },
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
                    console.log(`-> Loaded ${records.length} ${key}`);
                }
            } catch (e) {
                console.warn(`-> Failed to read ${dir} directory:`, e.message);
            }
        } else {
            fs.mkdirSync(folderPath, { recursive: true });
            console.log(`-> Created ${dir} directory`);
        }
    }
    
    console.log("--- DaDAA: Data Loading Complete ---");
    return worldData;
}

function saveEntity(entityType, entity) {
    const tempDataPath = path.join(__dirname, '..', '..', 'temp_data');
    
    const validTypes = ['characters', 'locations', 'items', 'quests', 'lore', 'encounters', 'sessions'];
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

function deleteEntity(entityType, entityId) {
    const tempDataPath = path.join(__dirname, '..', '..', 'temp_data');
    const filePath = path.join(tempDataPath, entityType, `${entityId}.json`);
    
    if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
        console.log(`-> Deleted ${entityType}/${entityId}`);
        return true;
    }
    
    return false;
}

function getEntity(entityType, entityId) {
    const tempDataPath = path.join(__dirname, '..', '..', 'temp_data');
    const filePath = path.join(tempDataPath, entityType, `${entityId}.json`);
    
    if (fs.existsSync(filePath)) {
        const content = fs.readFileSync(filePath, 'utf8');
        return JSON.parse(content);
    }
    
    return null;
}

module.exports = { 
    getAllWorldData, 
    saveEntity, 
    deleteEntity, 
    getEntity 
};
