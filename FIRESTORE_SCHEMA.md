# AMORA Firestore schema

Firestore uses generated document IDs for business records. Every business document must contain a string `storeId`, `createdAt`, and `updatedAt` timestamps. Monetary values are integer paise, not floating-point rupees. References use document IDs or paths consistently within a store.

| Collection | Required fields | Access |
| --- | --- | --- |
| `users` | `uid`, `email`, `role`, `storeId`, `active` | Self read/update with role/store immutable; trusted admin process for role assignment |
| `products` | `sku`, `name`, `sellingPricePaise`, `purchasePricePaise`, `storeId` | Authenticated read; manager/stock manager writes |
| `categories` | `name`, `storeId` | Authenticated read; manager/stock manager writes |
| `inventory` | `productId`, `availableQuantity`, `reorderLevel`, `storeId` | Authenticated read; stock roles write |
| `stock_movements` | `productId`, `type`, `quantity`, `performedBy`, `storeId` | Authenticated read; stock roles create |
| `suppliers` | `name`, `storeId` | Authenticated read; manager/stock manager writes |
| `purchase_orders` | `orderNumber`, `supplierId`, `items`, `totalPaise`, `storeId` | Authenticated read; manager/stock manager writes |
| `sales` | `invoiceNumber`, `items`, `totalPaise`, `cashierId`, `storeId` | Authenticated read/create; backend should own reconciliation |
| `customers` | `name`, `storeId` | Authenticated read/create |
| `batches` | `productId`, `batchNumber`, `expiryDate`, `remainingQuantity`, `storeId` | Authenticated read; stock roles write |
| `expenses` | `category`, `amountPaise`, `paidAt`, `storeId` | Authenticated read; manager writes |
| `payments` | `method`, `amountPaise`, `status`, `storeId` | Authenticated read/create |
| `notifications` | `type`, `title`, `message`, `storeId` | Authenticated read/create |
| `audit_logs` | `actorUid`, `action`, `entity`, `storeId` | Authenticated read; server/trusted operations create |
| `ai_predictions` | `model`, `prediction`, `confidence`, `storeId` | Authenticated read; trusted operations create |
| `reports` | `type`, `period`, `storeId` | Authenticated read; manager create |
| `settings` | `key`, `value`, `storeId` | Authenticated read; manager writes |

`firebase-services.js` supplies generated IDs, server timestamps, filtering, ordering, limits, and real-time subscriptions. It does not create seed records. Create test documents only in the emulator or in an explicitly isolated test store after approval.
