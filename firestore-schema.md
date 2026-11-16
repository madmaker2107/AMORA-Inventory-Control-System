# AMORA Firestore schema

All business documents use a generated document ID, `storeId`, `createdAt`, and `updatedAt`. References use document paths or IDs consistently within a store.

| Collection | Core fields |
| --- | --- |
| `users` | `uid`, `displayName`, `email`, `role`, `storeId`, `emailVerified`, `active` |
| `products` | `sku`, `barcode`, `name`, `categoryId`, `brand`, `unit`, `purchasePrice`, `sellingPrice`, `gstRate`, `minStock`, `active`, `storeId` |
| `categories` | `name`, `description`, `active`, `storeId` |
| `inventory` | `productId`, `availableQuantity`, `reservedQuantity`, `reorderLevel`, `storeId` |
| `stock_movements` | `productId`, `batchId`, `type`, `quantity`, `referenceId`, `performedBy`, `storeId` |
| `suppliers` | `name`, `phone`, `email`, `address`, `gstin`, `active`, `storeId` |
| `purchase_orders` | `orderNumber`, `supplierId`, `status`, `items`, `total`, `expectedDate`, `createdBy`, `storeId` |
| `sales` | `invoiceNumber`, `customerId`, `items`, `subtotal`, `tax`, `discount`, `total`, `paymentMethod`, `cashierId`, `storeId` |
| `customers` | `name`, `phone`, `email`, `loyaltyPoints`, `storeId` |
| `batches` | `productId`, `batchNumber`, `manufacturingDate`, `expiryDate`, `receivedQuantity`, `remainingQuantity`, `purchasePrice`, `storeId` |
| `expenses` | `category`, `amount`, `description`, `paidAt`, `createdBy`, `storeId` |
| `payments` | `saleId`, `purchaseOrderId`, `method`, `amount`, `status`, `storeId` |
| `notifications` | `type`, `title`, `message`, `readBy`, `storeId` |
| `audit_logs` | `actorUid`, `action`, `entity`, `entityId`, `details`, `storeId` |
| `ai_predictions` | `model`, `inputPeriod`, `prediction`, `confidence`, `productId`, `storeId` |
| `reports` | `type`, `period`, `storagePath`, `createdBy`, `storeId` |
| `settings` | `key`, `value`, `updatedBy`, `storeId` |

Use subcollections for high-volume child records when query patterns require it, such as `purchase_orders/{id}/items` and `sales/{id}/items`. Do not place service-account credentials or private keys in Firestore.
