// Storeify Watches - Appwrite Integration Module (SECURE VERSION)
// Uses the official Appwrite Web SDK with Session-based Authentication.
//
// HOW IT WORKS:
// ─────────────────────────────────────────────────────────────────
// ✅ Public store pages (index.html, products.html, product.html):
//    They call functions like getAllProducts() which use "Guest" access.
//    Appwrite allows this because we set "Any = Read" on the collection.
//
// ✅ Admin dashboard (admin/dashboard.html):
//    After the admin logs in with email+password, Appwrite sets a secure
//    session cookie in the browser. All subsequent calls (addProduct,
//    updateProduct, deleteProduct) automatically send this cookie.
//    Appwrite checks: "Does this session belong to a user with write access?"
//    Since we set "Users = CRUD" on the collection, it succeeds.
//
// ❌ What changed vs before:
//    We removed the API key from this file. It was visible to EVERYONE.
//    Now there is literally no secret in this file.
// ─────────────────────────────────────────────────────────────────

// ===== Initialize the Appwrite Web SDK =====
// The SDK is loaded via a <script> tag in HTML files. It provides the
// Client, Databases, Account, and Storage classes.

let appwriteClient;
let appwriteDatabases;
let appwriteAccount;
let appwriteStorage;

function initAppwriteSDK() {
    // The Appwrite SDK creates these classes from the global `Appwrite` object
    // loaded from the CDN script in your HTML files.
    const { Client, Databases, Account, Storage, ID, Query } = Appwrite;

    appwriteClient = new Client()
        .setEndpoint(CONFIG.appwrite.endpoint)
        .setProject(CONFIG.appwrite.projectId);

    appwriteDatabases = new Databases(appwriteClient);
    appwriteAccount = new Account(appwriteClient);
    appwriteStorage = new Storage(appwriteClient);

    // Make ID and Query helpers available globally for convenience
    window.AppwriteID = ID;
    window.AppwriteQuery = Query;
}

// Initialize on load
initAppwriteSDK();

// ===== AppwriteDB Class =====
// Wraps all database operations. The SDK automatically handles the
// session cookie, so we don't need to pass any API key anywhere.

class AppwriteDB {
    constructor() {
        this.databaseId = CONFIG.appwrite.databaseId;
        this.productsCollectionId = CONFIG.appwrite.productsCollectionId;
        this.bucketId = CONFIG.appwrite.bucketId;

        // Cache configuration
        this.cacheConfig = {
            enabled: true,
            defaultTTL: 5 * 60 * 1000,
            productsKey: 'cached_products',
            productPrefix: 'cached_product_',
            categoryCountsKey: 'cached_category_counts',
            lastFetchKey: 'last_fetch_time',
            dataVersionKey: 'products_data_version'
        };

        this.currentDataVersion = this.getDataVersion();
        this.initCacheCleanup();
    }

    // ===== Authentication Helpers =====
    // These are used by the admin pages for login/logout and session checks.

    // Log in with email and password (used on admin/index.html)
    // WHAT HAPPENS: Appwrite creates a session cookie in the browser.
    // Every request after this automatically carries that cookie.
    async login(email, password) {
        return await appwriteAccount.createEmailPasswordSession(email, password);
    }

    // Log out the current session (used on admin/dashboard.html logout button)
    // WHAT HAPPENS: Appwrite deletes the session cookie. Admin is signed out.
    async logout() {
        return await appwriteAccount.deleteSession('current');
    }

    // Get the currently logged-in user (or null if not logged in)
    // WHAT HAPPENS: SDK sends the session cookie; Appwrite returns user data.
    // Used on dashboard.html to verify the admin is still authenticated.
    async getCurrentUser() {
        try {
            return await appwriteAccount.get();
        } catch (error) {
            return null; // Returns null if not logged in (guest)
        }
    }

    // ===== Cache Management =====

    initCacheCleanup() {
        this.cleanExpiredCache();
        setInterval(() => this.cleanExpiredCache(), 10 * 60 * 1000);
    }

    getFromCache(key) {
        if (!this.cacheConfig.enabled) return null;
        try {
            const cached = localStorage.getItem(key);
            if (!cached) return null;
            const data = JSON.parse(cached);
            if (data.expiry && data.expiry < Date.now()) {
                localStorage.removeItem(key);
                return null;
            }
            return data.value;
        } catch (error) {
            return null;
        }
    }

    getDataVersion() {
        try {
            return localStorage.getItem(this.cacheConfig.dataVersionKey) || '0';
        } catch (error) {
            return '0';
        }
    }

    bumpDataVersion() {
        const newVersion = Date.now().toString();
        try {
            localStorage.setItem(this.cacheConfig.dataVersionKey, newVersion);
        } catch (error) {
            console.warn('Data version update error:', error);
        }
        this.currentDataVersion = newVersion;
    }

    syncCacheVersion() {
        const latestVersion = this.getDataVersion();
        if (latestVersion !== this.currentDataVersion) {
            this.clearProductsCache();
            this.currentDataVersion = latestVersion;
        }
    }

    setCache(key, value, ttl = this.cacheConfig.defaultTTL) {
        if (!this.cacheConfig.enabled) return;
        try {
            const data = { value, expiry: Date.now() + ttl, timestamp: Date.now() };
            localStorage.setItem(key, JSON.stringify(data));
        } catch (error) {
            if (error.name === 'QuotaExceededError') this.clearOldCache();
        }
    }

    removeFromCache(key) {
        try { localStorage.removeItem(key); } catch (e) {}
    }

    clearProductsCache() {
        try {
            localStorage.removeItem(this.cacheConfig.productsKey);
            localStorage.removeItem(this.cacheConfig.categoryCountsKey);
            localStorage.removeItem(this.cacheConfig.lastFetchKey);
            for (let i = localStorage.length - 1; i >= 0; i--) {
                const key = localStorage.key(i);
                if (key && key.startsWith(this.cacheConfig.productPrefix)) {
                    localStorage.removeItem(key);
                }
            }
        } catch (error) {
            console.warn('Cache clear error:', error);
        }
    }

    cleanExpiredCache() {
        try {
            const now = Date.now();
            for (let i = localStorage.length - 1; i >= 0; i--) {
                const key = localStorage.key(i);
                if (key && (key.startsWith('cached_') || key.startsWith(this.cacheConfig.productPrefix))) {
                    try {
                        const cached = JSON.parse(localStorage.getItem(key));
                        if (cached.expiry && cached.expiry < now) localStorage.removeItem(key);
                    } catch (e) {
                        localStorage.removeItem(key);
                    }
                }
            }
        } catch (error) {}
    }

    clearOldCache() {
        try {
            const entries = [];
            for (let i = 0; i < localStorage.length; i++) {
                const key = localStorage.key(i);
                if (key && (key.startsWith('cached_') || key.startsWith(this.cacheConfig.productPrefix))) {
                    try {
                        const cached = JSON.parse(localStorage.getItem(key));
                        entries.push({ key, timestamp: cached.timestamp || 0 });
                    } catch (e) { localStorage.removeItem(key); }
                }
            }
            entries.sort((a, b) => a.timestamp - b.timestamp);
            const toRemove = Math.ceil(entries.length / 2);
            for (let i = 0; i < toRemove; i++) localStorage.removeItem(entries[i].key);
        } catch (error) {}
    }

    // ===== Product Operations (Public - No Session Required) =====
    // These use Appwrite's "Any = Read" permission. No login needed.

    async getAllProducts(options = {}) {
        const { category, featured, limit = 100, offset = 0, forceRefresh = false } = options;
        this.syncCacheVersion();

        const cacheKey = `${this.cacheConfig.productsKey}_${category || 'all'}_${featured || 'false'}_${limit}_${offset}`;
        if (!forceRefresh) {
            const cached = this.getFromCache(cacheKey);
            if (cached) return cached;
        }

        try {
            // Build query using the SDK's Query helper
            // HOW IT WORKS: The SDK builds clean query strings and sends them to
            // your Appwrite endpoint. No API key needed for reads.
            const queries = [
                AppwriteQuery.limit(limit),
                AppwriteQuery.offset(offset),
                AppwriteQuery.orderDesc('$createdAt')
            ];

            if (category && category !== 'all') {
                queries.push(AppwriteQuery.equal('category', category));
            }
            if (featured) {
                queries.push(AppwriteQuery.equal('featured', true));
            }

            const response = await appwriteDatabases.listDocuments(
                this.databaseId,
                this.productsCollectionId,
                queries
            );

            const products = this.formatDocuments(response.documents || []);
            this.setCache(cacheKey, products);
            this.setCache(this.cacheConfig.lastFetchKey, Date.now());
            return products;

        } catch (error) {
            console.error('Error fetching products:', error);
            const cached = this.getFromCache(cacheKey);
            if (cached) return cached;
            throw error;
        }
    }

    async getProductById(id, options = {}) {
        const { forceRefresh = false } = options;
        const cacheKey = `${this.cacheConfig.productPrefix}${id}`;
        this.syncCacheVersion();

        if (!forceRefresh) {
            const cached = this.getFromCache(cacheKey);
            if (cached) return cached;
        }

        try {
            const doc = await appwriteDatabases.getDocument(
                this.databaseId,
                this.productsCollectionId,
                id
            );
            const product = this.formatDocument(doc);
            this.setCache(cacheKey, product);
            return product;
        } catch (error) {
            if (error.code === 404) return null;
            const cached = this.getFromCache(cacheKey);
            if (cached) return cached;
            throw error;
        }
    }

    async getProductsByCategory(category, options = {}) {
        return this.getAllProducts({ category, ...options });
    }

    async getFeaturedProducts(limit = 6, options = {}) {
        return this.getAllProducts({ featured: true, limit, ...options });
    }

    async searchProducts(query, options = {}) {
        try {
            const allProducts = await this.getAllProducts({ limit: 1000, ...options });
            const searchTerm = query.toLowerCase();
            return allProducts.filter(product =>
                (product.product_name && product.product_name.toLowerCase().includes(searchTerm)) ||
                (product.short_description && product.short_description.toLowerCase().includes(searchTerm)) ||
                (product.category && product.category.toLowerCase().includes(searchTerm)) ||
                (product.product_tags && product.product_tags.some(tag => tag.toLowerCase().includes(searchTerm)))
            );
        } catch (error) {
            console.error('Error searching products:', error);
            throw error;
        }
    }

    // ===== Admin Operations (Require Active Session) =====
    // These require the admin to be logged in via appwriteAccount.createEmailPasswordSession().
    // The SDK sends the session cookie automatically. Appwrite validates it
    // against your Collection's "Users = CRUD" permission.

    async addProduct(productData) {
        try {
            // HOW IT WORKS: The SDK sends the session cookie with this request.
            // Appwrite sees a valid logged-in user and allows the Create operation.
            const formattedData = this.formatDataForAppwrite(productData);
            const doc = await appwriteDatabases.createDocument(
                this.databaseId,
                this.productsCollectionId,
                AppwriteID.unique(), // Generates a unique document ID
                formattedData
            );
            this.clearProductsCache();
            this.bumpDataVersion();
            return this.formatDocument(doc);
        } catch (error) {
            console.error('Error adding product:', error);
            throw error;
        }
    }

    async updateProduct(id, productData) {
        try {
            const formattedData = this.formatDataForAppwrite(productData);
            const doc = await appwriteDatabases.updateDocument(
                this.databaseId,
                this.productsCollectionId,
                id,
                formattedData
            );
            const product = this.formatDocument(doc);
            this.setCache(`${this.cacheConfig.productPrefix}${id}`, product);
            this.clearProductsCache();
            this.bumpDataVersion();
            return product;
        } catch (error) {
            console.error('Error updating product:', error);
            throw error;
        }
    }

    async deleteProduct(id) {
        try {
            await appwriteDatabases.deleteDocument(
                this.databaseId,
                this.productsCollectionId,
                id
            );
            this.removeFromCache(`${this.cacheConfig.productPrefix}${id}`);
            this.clearProductsCache();
            this.bumpDataVersion();
            return true;
        } catch (error) {
            console.error('Error deleting product:', error);
            throw error;
        }
    }

    async updateStock(id, quantity) {
        return await this.updateProduct(id, { stock_quantity: quantity });
    }

    // ===== Storage Operations =====

    extractFileIdFromUrl(fileUrl) {
        const value = String(fileUrl || '');
        const match = value.match(/\/files\/([^/]+)\/view/i);
        return match ? match[1] : null;
    }

    async deleteImageByUrl(fileUrl) {
        const fileId = this.extractFileIdFromUrl(fileUrl);
        if (!fileId) return false;
        try {
            await appwriteStorage.deleteFile(this.bucketId, fileId);
            return true;
        } catch (error) {
            if (error.code === 404) return true; // Already deleted
            console.warn('Error deleting image:', error);
            return false;
        }
    }

    async deleteImagesByUrls(urls = []) {
        if (!Array.isArray(urls) || urls.length === 0) return;
        await Promise.all(urls.map(url => this.deleteImageByUrl(url)));
    }

    async uploadImage(file, folder = 'product-images') {
        try {
            const timestamp = Date.now();
            const randomString = Math.random().toString(36).substring(2, 10);
            const fileExt = file.name.split('.').pop().toLowerCase();
            const fileName = `${folder}/${timestamp}_${randomString}.${fileExt}`;

            // HOW IT WORKS: The SDK uses your session cookie to authenticate this
            // upload request. Appwrite checks "Users = Create" on the bucket.
            const uploadedFile = await appwriteStorage.createFile(
                this.bucketId,
                AppwriteID.unique(),
                new File([file], fileName, { type: file.type })
            );

            const publicUrl = `${CONFIG.appwrite.endpoint}/storage/buckets/${this.bucketId}/files/${uploadedFile.$id}/view?project=${CONFIG.appwrite.projectId}`;
            return publicUrl;
        } catch (error) {
            console.error('Error uploading image:', error);
            throw error;
        }
    }

    // ===== Statistics =====

    async getCategoryCounts(forceRefresh = false) {
        this.syncCacheVersion();
        if (!forceRefresh) {
            const cached = this.getFromCache(this.cacheConfig.categoryCountsKey);
            if (cached) return cached;
        }
        try {
            const products = await this.getAllProducts({ limit: 1000 });
            const counts = {};
            products.forEach(product => {
                if (product.category) counts[product.category] = (counts[product.category] || 0) + 1;
            });
            this.setCache(this.cacheConfig.categoryCountsKey, counts);
            return counts;
        } catch (error) {
            const cached = this.getFromCache(this.cacheConfig.categoryCountsKey);
            if (cached) return cached;
            throw error;
        }
    }

    async getProductCount() {
        const products = await this.getAllProducts({ limit: 1000 });
        return products.length;
    }

    // ===== Data Formatting =====

    normalizeProductImageUrls(rawValue) {
        if (Array.isArray(rawValue)) return rawValue.filter(Boolean).slice(0, 5);
        if (typeof rawValue === 'string') {
            const trimmed = rawValue.trim();
            if (!trimmed) return [];
            if (trimmed.startsWith('[')) {
                try {
                    const parsed = JSON.parse(trimmed);
                    if (Array.isArray(parsed)) return parsed.filter(Boolean).slice(0, 5);
                } catch (e) {}
            }
            return [trimmed].slice(0, 5);
        }
        return [];
    }

    formatDocument(doc) {
        if (!doc) return null;
        const productImageUrls = this.normalizeProductImageUrls(doc.product_image_urls);
        const primaryImage = productImageUrls[0] || doc.product_image_url || 'https://via.placeholder.com/300x300?text=No+Image';
        return {
            $id: doc.$id,
            id: doc.$id,
            product_name: doc.product_name || '',
            name: doc.product_name || '',
            short_description: doc.short_description || '',
            description: doc.short_description || '',
            main_price: doc.main_price || 0,
            price: doc.main_price || 0,
            original_price: doc.main_price || 0,
            discount_price: doc.discount_price || null,
            category: doc.category || 'uncategorized',
            category_name: doc.category || 'uncategorized',
            product_image_url: primaryImage,
            product_image_urls: productImageUrls.length > 0 ? productImageUrls : (doc.product_image_url ? [doc.product_image_url] : []),
            image: primaryImage,
            stock_quantity: doc.stock_quantity || 0,
            stock: doc.stock_quantity || 0,
            colour_options: doc.colour_options || [],
            colors: doc.colour_options || [],
            product_tags: doc.product_tags || [],
            tags: doc.product_tags || [],
            featured: doc.featured || false,
            badge: doc.badge || '',
            product_colour: doc.product_colour || '',
            box: doc.box || 'without box',
            box_price: doc.box_price || 0,
            created_date: doc.$createdAt || '',
            updated_date: doc.$updatedAt || ''
        };
    }

    formatDocuments(docs) {
        if (!Array.isArray(docs)) return [];
        return docs.map(doc => this.formatDocument(doc)).filter(Boolean);
    }

    formatDataForAppwrite(data) {
        const formatted = {};
        if (data.product_name !== undefined) formatted.product_name = data.product_name;
        if (data.category !== undefined) formatted.category = data.category;
        if (data.main_price !== undefined) formatted.main_price = data.main_price;
        if (data.discount_price !== undefined) formatted.discount_price = data.discount_price;
        if (data.stock_quantity !== undefined) formatted.stock_quantity = data.stock_quantity;
        if (data.short_description !== undefined) formatted.short_description = data.short_description;
        if (data.product_image_url !== undefined) formatted.product_image_url = data.product_image_url;
        if (data.product_image_urls !== undefined) {
            const normalized = this.normalizeProductImageUrls(data.product_image_urls);
            formatted.product_image_urls = JSON.stringify(normalized || []);
        }
        if (data.colour_options !== undefined) formatted.colour_options = data.colour_options;
        if (data.product_tags !== undefined) formatted.product_tags = data.product_tags;
        if (data.featured !== undefined) formatted.featured = data.featured;
        if (data.badge !== undefined) formatted.badge = data.badge;
        if (data.product_colour !== undefined) formatted.product_colour = data.product_colour;
        if (data.box !== undefined) formatted.box = data.box;
        if (data.box_price !== undefined) formatted.box_price = data.box_price;
        return formatted;
    }
}

// Create global instance used by all pages
const appwriteDB = new AppwriteDB();
