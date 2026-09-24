import {Webhook} from "svix"
import User from "../models/User.js"
import { Stripe } from 'stripe';
import Purchase from "../models/Purchase.js";
import Course from "../models/Course.js";


//API controller function to manage clerk user with database

export const clerkWebhooks=async(req , res)=>{
    try {
        const whook=new Webhook(process.env.CLERK_WEBHOOK_SECRET) //create new webhook
       //wait for verification of that webhook created
        await whook.verify(JSON.stringify(req.body),
    {
         "svix-id" :req.headers["svix-id"],
         "svix-timestamp":req.headers["svix-timestamp"],
         "svix-signature":req.headers["svix-signature"]
    })
    //if verified fetch data and type from req.body
    const {data,type}=req.body

    switch (type) {
        case 'user.created':{ //if type is user.created
            //fetch the data of user created
            const userData={
                _id:data.id,
                email:data.email_addresses[0].email_address,
                name:data.first_name + " " + data.last_name,
                imageUrl:data.image_url,
            }
            // store the userdata created in MongoDB
            await User.create(userData)
            res.json({}) //why this???????????
            break;
        }
            
         case 'user.updated':{
            const userData={
                email:data.email_addresses[0].email_address,
                name:data.first_name + " " + data.last_name,
                imageUrl:data.image_url,
            }
            await User.findByIdAndUpdate(data.id,userData) //find by data.id and update with userData
            res.json({})
            break;
         }

         case 'user.deleted':
            {
                await User.findByIdAndDelete(data.id)
                res.json({})
                break;
            }
    
        default:
            break;
    }
    
        
    } catch (error) {
        res.json({success:false,message:error.message})
    }
}

//CREATING WEBHOOKS OF Stripe

const stripeInstance = new Stripe(process.env.STRIPE_SECRET_KEY)

export const stripeWebhooks = async(request, response)=>{
    const sig=request.headers['stripe-signature'];

    let event;

    try {
        event=Stripe.webhooks.constructEvent(request.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
    } catch (error) {
        return response.status(400).send(`webhook Error:${error.message}`);
        // BUG FIX: this was missing `return`, so on a bad signature execution fell
        // through into the switch below with `event` undefined, throwing again.
    }

    //handle the event that we are getting above in try block

    switch (event.type) {
        case 'payment_intent.succeeded':{
            const paymentIntent = event.data.object;
            const paymentIntentId = paymentIntent.id;

            const session = await stripeInstance.checkout.sessions.list({
                payment_intent:paymentIntentId
            })

            const {purchaseId} = session.data[0].metadata;

            // IDEMPOTENCY GUARD: Stripe can (and does) redeliver the same webhook
            // event more than once — on retry, on timeout, or if two workers pick up
            // the same delivery. This atomically claims the purchase by flipping its
            // status only if it isn't already 'completed'. If another delivery of the
            // same event already completed it, findOneAndUpdate returns null here and
            // we stop — no duplicate enrollment, no duplicate array pushes.
            const purchaseData = await Purchase.findOneAndUpdate(
                { _id: purchaseId, status: { $ne: 'completed' } },
                { status: 'completed' },
                { new: false } // return the pre-update doc so we still have userId/courseId
            );

            if (!purchaseData) {
                // Already processed by an earlier delivery of this same event — no-op.
                break;
            }

            const userId = purchaseData.userId;
            const courseId = purchaseData.courseId.toString();

            const course = await Course.findById(courseId).select('maxSeats');
            let courseData;

            if (course && course.maxSeats != null) {
                // RACE-CONDITION FIX: seat-limited course. This does the
                // "is a seat available" check and the seat decrement as a single
                // atomic MongoDB operation, so two concurrent webhook deliveries
                // (or two students whose payments clear at the same instant)
                // cannot both succeed off a stale seat count.
                courseData = await Course.findOneAndUpdate(
                    { _id: courseId, seatsRemaining: { $gt: 0 } },
                    {
                        $addToSet: { enrolledStudents: userId }, // no-op if already present
                        $inc: { seatsRemaining: -1 }
                    },
                    { new: true }
                );

                if (!courseData) {
                    // Payment cleared but seats ran out in the meantime. Don't
                    // silently drop the enrollment — flag it for a refund/manual review.
                    await Purchase.findByIdAndUpdate(purchaseId, { status: 'failed_no_seats' });
                    break;
                }
            } else {
                // Unlimited-seat course — original behavior, made idempotent via $addToSet.
                courseData = await Course.findByIdAndUpdate(
                    courseId,
                    { $addToSet: { enrolledStudents: userId } },
                    { new: true }
                );
            }

            // $addToSet keeps this safe even if this code somehow ran twice.
            await User.findByIdAndUpdate(userId, { $addToSet: { enrolledCourses: courseId } });

            break;
        }

        case 'payment_intent.payment_failed':{
             const paymentIntent = event.data.object;
            const paymentIntentId = paymentIntent.id;

            const session = await stripeInstance.checkout.sessions.list({
                payment_intent:paymentIntentId
            })

            const {purchaseId} = session.data[0].metadata;
            const purchaseData = await Purchase.findById(purchaseId)
            
            purchaseData.status = 'failed'
            await purchaseData.save()

        break;}
       //.... handle other event types
        default:
            console.log(`Unhandled event type ${event.type}`);

            
            
    }
    response.json({received: true});
    
}
